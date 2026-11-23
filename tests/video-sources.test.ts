import { describe, expect, it } from 'vitest';
import { extractBunnyHlsFromHtml } from '@/lib/bunny';
import {
  buildIframeSrcWithFreshTime,
  collectEpisodeSources,
  detectSourceKind,
  getIframeReferrerPolicy,
  getNextFallbackSourceIndex,
  hasUrlHashParams,
  normalizeVideoSource,
  validateHttpUrl,
} from '@/lib/video-sources';

describe('validateHttpUrl', () => {
  it('aceita URLs HTTP e HTTPS válidas e remove espaços extras', () => {
    const res = validateHttpUrl('  https://cdn.example.com/video.mp4  ');
    expect(res.valid).toBe(true);
    expect(res.normalizedUrl).toBe('https://cdn.example.com/video.mp4');
  });

  it('rejeita esquemas perigosos e URLs inválidas', () => {
    expect(validateHttpUrl('javascript:alert(1)').valid).toBe(false);
    expect(validateHttpUrl('data:text/html,<script>').valid).toBe(false);
    expect(validateHttpUrl('file:///etc/passwd').valid).toBe(false);
    expect(validateHttpUrl('ftp://cdn.example.com/ep1.mp4').valid).toBe(false);
    expect(validateHttpUrl('https://user:pass@cdn.example.com/ep1.mp4').valid).toBe(false);
    expect(validateHttpUrl('').valid).toBe(false);
    expect(validateHttpUrl('não é uma url').valid).toBe(false);
  });
});

describe('normalizeVideoSource', () => {
  it('identifica vídeos diretos MP4 e WebM', () => {
    const mp4 = normalizeVideoSource('https://cdn.example.com/anime/ep01.mp4?token=abc', 1);
    expect(mp4?.kind).toBe('mp4');
    expect(mp4?.provider).toBe('direct');
    expect(mp4?.needsProxy).toBe(true);

    const webm = normalizeVideoSource('https://cdn.example.com/anime/ep01.webm', 2);
    expect(webm?.kind).toBe('webm');
    expect(webm?.provider).toBe('direct');
  });

  it('identifica streams HLS (.m3u8 e .m3u)', () => {
    const m3u8 = normalizeVideoSource('https://cdn.example.com/hls/master.m3u8', 1);
    expect(m3u8?.kind).toBe('hls');
    expect(m3u8?.provider).toBe('hls');

    const m3u = normalizeVideoSource('https://cdn.example.com/playlist.m3u', 2);
    expect(m3u?.kind).toBe('hls');
  });

  it('converte URLs player.mux.com para stream.mux.com com playlist M3U8', () => {
    const mux = normalizeVideoSource('https://player.mux.com/AbCdEfGhIj123456?token=xyz', 1);
    expect(mux?.kind).toBe('hls');
    expect(mux?.provider).toBe('mux');
    expect(mux?.resolvedUrl).toBe('https://stream.mux.com/AbCdEfGhIj123456.m3u8?token=xyz');
    expect(mux?.fallbackIframeUrl).toBe('https://player.mux.com/AbCdEfGhIj123456?token=xyz');

    const muxDirect = normalizeVideoSource('https://stream.mux.com/AbCdEfGhIj123456.m3u8', 2);
    expect(muxDirect?.kind).toBe('hls');
    expect(muxDirect?.provider).toBe('mux');
  });

  it('reconhece URLs Bunny Stream (player.mediadelivery.net/embed) e extrai HLS do HTML', () => {
    const bunny = normalizeVideoSource(
      'https://player.mediadelivery.net/embed/12345/9c9d7a3b-1234-4567-89ab-cdef01234567?autoplay=false',
      1
    );
    expect(bunny?.kind).toBe('bunny');
    expect(bunny?.provider).toBe('bunny');
    expect(bunny?.requiresServerResolve).toBe(true);
    expect(bunny?.fallbackIframeUrl).toBe(
      'https://iframe.mediadelivery.net/embed/12345/9c9d7a3b-1234-4567-89ab-cdef01234567?autoplay=false'
    );

    const mockHtml = `<script>var src = "https://vz-a1b2c3d4-001.b-cdn.net/9c9d7a3b-1234-4567-89ab-cdef01234567/playlist.m3u8";</script>`;
    const extracted = extractBunnyHlsFromHtml(
      mockHtml,
      '9c9d7a3b-1234-4567-89ab-cdef01234567'
    );
    expect(extracted).toBe(
      'https://vz-a1b2c3d4-001.b-cdn.net/9c9d7a3b-1234-4567-89ab-cdef01234567/playlist.m3u8'
    );
  });

  it('marca fontes maximaimg.online para proxy dedicado', () => {
    const maxHls = normalizeVideoSource('https://cdn.maximaimg.online/stream/ep1/index.m3u8', 1);
    expect(maxHls?.provider).toBe('maximaimg');
    expect(maxHls?.kind).toBe('hls');
    expect(maxHls?.needsProxy).toBe(true);

    const maxMp4 = normalizeVideoSource('https://maximaimg.online/files/ep1.mp4', 2);
    expect(maxMp4?.provider).toBe('maximaimg');
    expect(maxMp4?.kind).toBe('mp4');
    expect(maxMp4?.needsProxy).toBe(true);
  });

  it('trata páginas HTML e incorporações como iframe e nunca como MP4', () => {
    const htmlPage = normalizeVideoSource('https://embeds.example.com/watch/episodio-1.html', 1);
    expect(htmlPage?.kind).toBe('iframe');
    expect(htmlPage?.provider).toBe('iframe');

    const embedRoute = normalizeVideoSource('https://streamtape.com/e/abc123def/', 2);
    expect(embedRoute?.kind).toBe('iframe');
  });
});

describe('collectEpisodeSources e seleção/fallback de fontes', () => {
  it('coleta até 5 fontes válidas e alterna automaticamente ignorando fontes com falha', () => {
    const sources = collectEpisodeSources({
      video_url: 'https://cdn.example.com/ep1.mp4',
      video_url_2: 'https://player.mux.com/Playback123456',
      video_url_3: '',
      video_url_4: 'https://cdn.maximaimg.online/ep1/master.m3u8',
      video_url_5: 'https://embeds.example.com/e/12345',
    });

    expect(sources.map((s) => s.slot)).toEqual([1, 2, 4, 5]);
    expect(sources[0].label).toBe('Player 1');
    expect(sources[2].label).toBe('Player 4');

    const failed = new Set<number>([1]);
    const next1 = getNextFallbackSourceIndex(sources, 0, failed);
    expect(next1).toBe(1); // Player 2

    failed.add(2);
    const next2 = getNextFallbackSourceIndex(sources, 1, failed);
    expect(next2).toBe(2); // Player 4

    failed.add(4);
    const next3 = getNextFallbackSourceIndex(sources, 2, failed);
    expect(next3).toBe(3); // Player 5

    failed.add(5);
    const exhausted = getNextFallbackSourceIndex(sources, 3, failed);
    expect(exhausted).toBeNull();
  });

  it('detecta kind automático (playerricas.php/.php -> iframe, .m3u8 -> hls, .mp4/.webm -> mp4) e respeita override explícito', () => {
    const playerricas =
      'https://www.anitube22.vip/playerricas.php?name=apphd/583375.mp4&img=https://www.hinatasoul.com/media/videos/tmb/583375/default.jpg&pais=pais=BR&time=1700000000&url=https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/ziphonec/583375.mp4';
    const phpHls =
      'https://api.anivideo.net/videohls.php?d=https://cdn-sv01.maximaimg.online/stream/b/bakemonogatari/01.mp4/index.m3u8';

    expect(detectSourceKind(playerricas)).toBe('iframe');
    expect(detectSourceKind(phpHls)).toBe('iframe');
    expect(detectSourceKind('https://cdn-sv01.maximaimg.online/ep1/index.m3u8')).toBe('hls');
    expect(detectSourceKind('https://cdn.example.com/ep1.mp4')).toBe('mp4');
    expect(detectSourceKind('https://cdn.example.com/ep1.webm')).toBe('mp4');

    // Override explícito
    expect(detectSourceKind('https://cdn.example.com/custom-player', 'iframe')).toBe('iframe');
    expect(detectSourceKind('https://cdn.example.com/stream', 'hls')).toBe('hls');
    expect(detectSourceKind('https://cdn.example.com/stream', 'mp4')).toBe('mp4');

    // normalizeVideoSource para playerricas.php / .php garante kind='iframe' e needsProxy=false
    const norm1 = normalizeVideoSource(playerricas, 1);
    expect(norm1?.kind).toBe('iframe');
    expect(norm1?.needsProxy).toBe(false);
    expect(norm1?.resolvedUrl).toBe(playerricas);

    const norm2 = normalizeVideoSource(phpHls, 2);
    expect(norm2?.kind).toBe('iframe');
    expect(norm2?.needsProxy).toBe(false);
  });

  it('substitui apenas o parâmetro time em URLs de iframe na montagem e preserva URLs sem time', () => {
    const withTime =
      'https://www.anitube22.vip/playerricas.php?name=apphd/583375.mp4&img=https://www.hinatasoul.com/media/videos/tmb/583375/default.jpg&pais=pais=BR&time=1700000000&url=https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/ziphonec/583375.mp4';
    const updated1 = buildIframeSrcWithFreshTime(withTime, 1795120001);
    const updated2 = buildIframeSrcWithFreshTime(withTime, 1795120015);

    expect(updated1).toContain('time=1795120001');
    expect(updated2).toContain('time=1795120015');
    expect(updated1).not.toBe(updated2);
    expect(updated1).toContain('pais=pais=BR');
    expect(updated1).toContain('url=https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/ziphonec/583375.mp4');

    const withoutTime = 'https://embeds.example.com/e/12345?runtime=900';
    expect(buildIframeSrcWithFreshTime(withoutTime, 1795120001)).toBe(withoutTime);
  });

  it('não reescreve time quando a URL possui parâmetros de hash (cv, cv2, cv3, cv4) e detecta hasUrlHashParams', () => {
    const urls = [
      'https://filevideo1.com/remote_control.php?time=1700000000&cv=abc123&file=ep.mp4',
      'https://filevideo1.com/remote_control.php?time=1700000000&cv2=def456&file=ep.mp4',
      'https://filevideo1.com/remote_control.php?time=1700000000&cv3=ghi789&file=ep.mp4',
      'https://filevideo1.com/remote_control.php?time=1700000000&cv4=jkl012&file=ep.mp4',
      'https://filevideo1.com/remote_control.php?file=ep.mp4&time=1700000000&cv=a&cv2=b&cv3=c&cv4=d',
    ];

    for (const url of urls) {
      expect(hasUrlHashParams(url)).toBe(true);
      expect(buildIframeSrcWithFreshTime(url, 1795120999)).toBe(url);
      expect(getIframeReferrerPolicy(url)).toBe('no-referrer');
      const norm = normalizeVideoSource(url, 1);
      expect(norm?.kind).toBe('iframe');
      expect(norm?.needsProxy).toBe(false);
    }

    expect(
      hasUrlHashParams('https://www.anitube22.vip/playerricas.php?id=123&time=1700000000')
    ).toBe(false);
  });

  it('ativa needsProxy=true por padrão para fontes hls/mp4 (incluindo mywallpaper-4k-image.net) e mantém false apenas para iframe', () => {
    const wallpaperHls = normalizeVideoSource(
      'https://cdn-s01.mywallpaper-4k-image.net/stream/anime/01/index.m3u8',
      1
    );
    expect(wallpaperHls?.kind).toBe('hls');
    expect(wallpaperHls?.needsProxy).toBe(true);

    const genericMp4 = normalizeVideoSource('https://cdn.example.com/ep01.mp4', 2);
    expect(genericMp4?.kind).toBe('mp4');
    expect(genericMp4?.needsProxy).toBe(true);

    const iframe = normalizeVideoSource('https://embeds.example.com/player.html', 3);
    expect(iframe?.kind).toBe('iframe');
    expect(iframe?.needsProxy).toBe(false);
  });
});
