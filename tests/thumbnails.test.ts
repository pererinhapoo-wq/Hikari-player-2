import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerEpisode } from '@/lib/db';
import {
  buildThumbnailTimestamps,
  formatThumbnailTimeLabel,
  MAX_THUMBNAIL_UPLOAD_BYTES,
  pickBestThumbnailCandidate,
} from '@/lib/thumbnail-utils';
import {
  buildThumbnailBlobPathname,
  detectImageMagicMime,
  handleThumbnailUploadRequest,
  resolveThumbnailSourceForAdmin,
} from '@/lib/thumbnails';

function makeEpisode(overrides: Partial<PlayerEpisode> = {}): PlayerEpisode {
  return {
    id: 'ep-thumb-1',
    anime_name: 'Solo Leveling',
    episode_number: '01',
    opening_start_seconds: null,
    opening_end_seconds: null,
    title: 'Episódio 1',
    poster_url: 'https://cdn.example.com/poster-original.jpg',
    video_url: 'https://anitube22.vip/embed/123',
    source_kind: 'iframe',
    is_mirror: false,
    force_proxy: null,
    video_url_2: null,
    source_kind_2: null,
    is_mirror_2: false,
    force_proxy_2: null,
    video_url_3: null,
    source_kind_3: null,
    is_mirror_3: false,
    force_proxy_3: null,
    video_url_4: null,
    source_kind_4: null,
    is_mirror_4: false,
    force_proxy_4: null,
    video_url_5: null,
    source_kind_5: null,
    is_mirror_5: false,
    force_proxy_5: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeFakeJpegBytes(size = 1024): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(size));
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xe0;
  return bytes;
}

describe('buildThumbnailTimestamps', () => {
  it('returns 6 distinct spread timestamps avoiding frame 0 and final credits', () => {
    const times = buildThumbnailTimestamps(1440, 6); // 24 min episode
    expect(times).toHaveLength(6);
    expect(times[0]).toBeGreaterThan(10);
    expect(times[times.length - 1]).toBeLessThan(1440);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThan(times[i - 1]);
    }
  });

  it('handles 5-frame request and short clips safely', () => {
    expect(buildThumbnailTimestamps(600, 5)).toHaveLength(5);
    const shortTimes = buildThumbnailTimestamps(3, 6);
    expect(shortTimes.length).toBeGreaterThanOrEqual(5);
    expect(shortTimes[0]).toBeGreaterThan(0);
    expect(shortTimes[shortTimes.length - 1]).toBeLessThan(3);
  });

  it('returns empty array for invalid durations and formats time labels cleanly', () => {
    expect(buildThumbnailTimestamps(0)).toEqual([]);
    expect(buildThumbnailTimestamps(Number.NaN)).toEqual([]);
    expect(formatThumbnailTimeLabel(125)).toBe('02:05');
    expect(formatThumbnailTimeLabel(3665)).toBe('1:01:05');
  });
});

describe('pickBestThumbnailCandidate & resolveThumbnailSourceForAdmin', () => {
  it('prioritizes Vercel Blob video URL even when slot 1 is an external embed', async () => {
    const blobUrl =
      'https://q70piqtcusyiwtbz.public.blob.vercel-storage.com/mirrors/sem-anime/cI5nEfJUlGMA-_RXK0aww.mp4';
    const ep = makeEpisode({
      video_url: 'https://anitube22.vip/embed/123',
      source_kind: 'iframe',
      video_url_2: blobUrl,
      source_kind_2: 'mp4',
      is_mirror_2: true,
    });

    const plan = await resolveThumbnailSourceForAdmin(
      {
        episodeId: ep.id,
        videoUrl: ep.video_url,
        sourceKind: 'iframe',
      },
      {
        isDbConfigured: () => true,
        getEpisodeById: async () => ep,
        signProxyUrl: (url) => `/api/proxy/stream?url=${encodeURIComponent(url)}`,
      }
    );

    expect(plan.ok).toBe(true);
    expect(plan.mode).toBe('direct');
    expect(plan.blobPreferred).toBe(true);
    expect(plan.directUrl).toBe(blobUrl);
    expect(plan.sourceLabel).toContain('Vercel Blob');
  });

  it('supports MP4, WebM, M3U8, and Mux player sources', async () => {
    const mp4 = await resolveThumbnailSourceForAdmin(
      { videoUrl: 'https://cdn.example.com/videos/ep01.mp4' },
      { signProxyUrl: (u) => `/proxy?u=${encodeURIComponent(u)}` }
    );
    expect(mp4.ok).toBe(true);
    expect(mp4.mode).toBe('direct');
    expect(mp4.sourceKind).toBe('mp4');

    const webm = await resolveThumbnailSourceForAdmin(
      { videoUrl: 'https://cdn.example.com/videos/ep01.webm' },
      { signProxyUrl: (u) => `/proxy?u=${encodeURIComponent(u)}` }
    );
    expect(webm.ok).toBe(true);
    expect(webm.mode).toBe('direct');
    expect(webm.sourceKind).toBe('webm');

    const hls = await resolveThumbnailSourceForAdmin(
      { videoUrl: 'https://cdn.example.com/hls/master.m3u8' },
      { signProxyUrl: (u) => `/proxy?u=${encodeURIComponent(u)}` }
    );
    expect(hls.ok).toBe(true);
    expect(hls.mode).toBe('hls');

    const mux = await resolveThumbnailSourceForAdmin(
      { videoUrl: 'https://player.mux.com/PlaybackId123456' },
      { signProxyUrl: (u) => `/proxy?u=${encodeURIComponent(u)}` }
    );
    expect(mux.ok).toBe(true);
    expect(mux.mode).toBe('hls');
    expect(mux.directUrl).toBe('https://stream.mux.com/PlaybackId123456.m3u8');
  });

  it('resolves Bunny embed to HLS when accessible and reports incompatibility cleanly when blocked', async () => {
    const resolved = await resolveThumbnailSourceForAdmin(
      { videoUrl: 'https://player.mediadelivery.net/embed/123/12345678-1234-1234-1234-1234567890ab' },
      {
        resolveBunny: async (embedUrl) => ({
          ok: true,
          embedUrl,
          hlsUrl: 'https://vz-abc.b-cdn.net/12345678-1234-1234-1234-1234567890ab/playlist.m3u8',
        }),
        signProxyUrl: (u) => `/proxy?u=${encodeURIComponent(u)}`,
      }
    );
    expect(resolved.ok).toBe(true);
    expect(resolved.mode).toBe('hls');
    expect(resolved.directUrl).toContain('playlist.m3u8');

    const blocked = await resolveThumbnailSourceForAdmin(
      { videoUrl: 'https://player.mediadelivery.net/embed/123/12345678-1234-1234-1234-1234567890ab' },
      {
        resolveBunny: async (embedUrl) => ({
          ok: false,
          embedUrl,
          reason: 'Playlist protegida',
        }),
      }
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.mode).toBe('incompatible');
    expect(blocked.reason).toContain('Playlist protegida');
  });

  it('returns clear incompatibility message for iframe embeds without direct/Blob video', async () => {
    const plan = await resolveThumbnailSourceForAdmin({
      videoUrl: 'https://filevideo1.com/embed/abc123',
      sourceKind: 'iframe',
    });
    expect(plan.ok).toBe(false);
    expect(plan.mode).toBe('incompatible');
    expect(plan.reason).toContain('embed externo');
    expect(plan.reason).toContain('filevideo1.com');
  });

  it('prefers direct MP4/HLS over iframe when multiple form/episode sources exist without Blob', () => {
    const picked = pickBestThumbnailCandidate([
      { slot: 1, url: 'https://anitube22.vip/embed/1', kind: 'iframe' },
      { slot: 2, url: 'https://cdn.example.com/ep01.mp4', kind: 'mp4' },
    ]);
    expect(picked?.kind).toBe('mp4');
    expect(picked?.slot).toBe(2);
  });
});

describe('image magic bytes & pathname helpers', () => {
  it('verifies JPEG, PNG, and WebP magic headers and rejects HTML/scripts', () => {
    expect(detectImageMagicMime(makeFakeJpegBytes())).toBe('image/jpeg');
    expect(
      detectImageMagicMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))
    ).toBe('image/png');
    expect(
      detectImageMagicMime(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
      )
    ).toBe('image/webp');
    expect(detectImageMagicMime(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull();
  });

  it('builds sanitized thumbnail blob pathnames', () => {
    expect(buildThumbnailBlobPathname('Frieren: Beyond', 'ep_01', 'jpg')).toBe(
      'thumbnails/frieren-beyond/ep_01.jpg'
    );
    expect(buildThumbnailBlobPathname('', '../evil/path', 'jpg')).toBe(
      'thumbnails/sem-anime/evilpath.jpg'
    );
  });
});

describe('handleThumbnailUploadRequest', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('enforces POST, same-origin, and admin session authentication', async () => {
    const getRes = await handleThumbnailUploadRequest(
      new Request('https://example.com/api/thumbnails', { method: 'GET' })
    );
    expect(getRes.status).toBe(405);

    const badOriginRes = await handleThumbnailUploadRequest(
      new Request('https://example.com/api/thumbnails', { method: 'POST' }),
      { verifyAdmin: () => ({ authenticated: true, sameOrigin: false }) }
    );
    expect(badOriginRes.status).toBe(403);

    const unauthRes = await handleThumbnailUploadRequest(
      new Request('https://example.com/api/thumbnails', { method: 'POST' }),
      { verifyAdmin: () => ({ authenticated: false, sameOrigin: true }) }
    );
    expect(unauthRes.status).toBe(401);
  });

  it('rejects non-image payloads and oversized files', async () => {
    const fakeSvgForm = new FormData();
    fakeSvgForm.append('file', new Blob(['<svg></svg>'], { type: 'image/jpeg' }), 'fake.jpg');

    const badMimeRes = await handleThumbnailUploadRequest(
      new Request('https://example.com/api/thumbnails', { method: 'POST', body: fakeSvgForm }),
      {
        verifyAdmin: () => ({ authenticated: true, sameOrigin: true }),
        blobToken: 'vercel_blob_rw_test',
      }
    );
    expect(badMimeRes.status).toBe(400);

    const hugeForm = new FormData();
    hugeForm.append(
      'file',
      new Blob([makeFakeJpegBytes(MAX_THUMBNAIL_UPLOAD_BYTES + 64)], { type: 'image/jpeg' }),
      'huge.jpg'
    );
    const hugeRes = await handleThumbnailUploadRequest(
      new Request('https://example.com/api/thumbnails', { method: 'POST', body: hugeForm }),
      {
        verifyAdmin: () => ({ authenticated: true, sameOrigin: true }),
        blobToken: 'vercel_blob_rw_test',
      }
    );
    expect(hugeRes.status).toBe(400);
  });

  it('uploads verified thumbnail to Vercel Blob and returns public HTTPS url', async () => {
    const form = new FormData();
    form.append('file', new Blob([makeFakeJpegBytes(2048)], { type: 'image/jpeg' }), 'thumb.jpg');
    form.append('animeName', 'Jujutsu Kaisen');
    form.append('episodeId', 'ep-123');

    const putBlob = vi.fn(async (pathname: string) => ({
      url: `https://q70piqtcusyiwtbz.public.blob.vercel-storage.com/${pathname}`,
      downloadUrl: `https://q70piqtcusyiwtbz.public.blob.vercel-storage.com/${pathname}`,
      pathname,
      contentType: 'image/jpeg',
      contentDisposition: 'inline',
      etag: 'etag-1',
    }));

    const res = await handleThumbnailUploadRequest(
      new Request('https://example.com/api/thumbnails', { method: 'POST', body: form }),
      {
        verifyAdmin: () => ({ authenticated: true, sameOrigin: true }),
        blobToken: 'vercel_blob_rw_test',
        putBlob: putBlob as never,
      }
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; url: string; pathname: string };
    expect(body.ok).toBe(true);
    expect(body.pathname).toBe('thumbnails/jujutsu-kaisen/ep-123.jpg');
    expect(body.url).toContain('public.blob.vercel-storage.com/thumbnails/jujutsu-kaisen/ep-123.jpg');
    expect(putBlob).toHaveBeenCalledTimes(1);
  });
});
