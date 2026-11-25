import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADMIN_SESSION_COOKIE_NAME, createSessionToken } from '@/lib/auth';
import {
  type DiagnosticSqlTag,
  type PlayerEpisode,
  saveEpisodeMirrorSource,
} from '@/lib/db';
import {
  buildMirrorBlobPathname,
  EXPIRED_MIRROR_LINK_MESSAGE,
  handleMirrorRequest,
  isAllowedMirrorSourceHost,
  isExpiredUpstreamResponse,
  mirrorEpisodeSource,
  safeFetchMirrorStream,
} from '@/lib/mirror';
import {
  collectEpisodeSources,
  isVercelBlobUrl,
  normalizeVideoSource,
} from '@/lib/video-sources';

function makePlayerEpisode(overrides: Partial<PlayerEpisode> = {}): PlayerEpisode {
  return {
    id: 'ep_mirror_test_01',
    anime_name: 'Frieren: Além da Jornada',
    episode_number: '01',
    opening_start_seconds: null,
    opening_end_seconds: null,
    title: 'O Fim da Jornada',
    poster_url: 'https://cdn.example.com/poster.jpg',
    video_url: 'https://anitube22.vip/playerricas.php?id=123',
    video_url_2: null,
    video_url_3: null,
    video_url_4: null,
    video_url_5: null,
    source_kind: 'iframe',
    source_kind_2: null,
    source_kind_3: null,
    source_kind_4: null,
    source_kind_5: null,
    force_proxy: false,
    force_proxy_2: true,
    force_proxy_3: true,
    force_proxy_4: true,
    force_proxy_5: true,
    is_mirror: false,
    is_mirror_2: false,
    is_mirror_3: false,
    is_mirror_4: false,
    is_mirror_5: false,
    created_at: '2026-11-20T12:00:00.000Z',
    updated_at: '2026-11-20T12:00:00.000Z',
    ...overrides,
  };
}

describe('Espelhamento no Vercel Blob (/api/mirror)', () => {
  it('1. aceita apenas hosts permitidos (*.r2.cloudflarestorage.com e CDNs de mídia do projeto)', () => {
    expect(isAllowedMirrorSourceHost('173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com')).toBe(true);
    expect(isAllowedMirrorSourceHost('cdn-sv01.maximaimg.online')).toBe(true);
    expect(isAllowedMirrorSourceHost('maximaimg.online')).toBe(true);
    expect(isAllowedMirrorSourceHost('cdn-s01.mywallpaper-4k-image.net')).toBe(true);
    expect(isAllowedMirrorSourceHost('vz-123.b-cdn.net')).toBe(true);
    expect(isAllowedMirrorSourceHost('stream.mux.com')).toBe(true);
    expect(isAllowedMirrorSourceHost('api.anivideo.net')).toBe(true);

    expect(isAllowedMirrorSourceHost('r2.cloudflarestorage.com')).toBe(false);
    expect(isAllowedMirrorSourceHost('evil.example.com')).toBe(false);
    expect(isAllowedMirrorSourceHost('127.0.0.1')).toBe(false);
    expect(isAllowedMirrorSourceHost('localhost')).toBe(false);
  });

  it('2. gera pathname estável mirrors/<animeId>/<episodioId>.mp4', () => {
    expect(buildMirrorBlobPathname('Frieren: Além da Jornada', 'ep_abc_123')).toBe(
      'mirrors/frieren-alem-da-jornada/ep_abc_123.mp4'
    );
    expect(buildMirrorBlobPathname(null, 'ep_legacy_9')).toBe(
      'mirrors/sem-anime/ep_legacy_9.mp4'
    );
  });

  it('3. faz streaming do download direto para put(pathname, body) com allowOverwrite e multipart sem carregar tudo em memória', async () => {
    const episode = makePlayerEpisode();
    const sourceStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0, 0, 0, 24]));
        controller.close();
      },
    });

    const capturedPuts: Array<{
      pathname: string;
      body: ReadableStream<Uint8Array>;
      options: Record<string, unknown>;
    }> = [];
    let savedArgs: { episodeId: string; blobUrl: string; force?: boolean } | null = null;

    const outcome = await mirrorEpisodeSource(
      {
        episodeId: episode.id,
        sourceUrl: 'https://bucket123.r2.cloudflarestorage.com/anime/ep01.mp4?X-Amz-Signature=fresh',
        force: false,
      },
      {
        isDbConfigured: () => true,
        blobToken: 'vercel_blob_rw_test_token',
        getEpisode: async () => episode,
        fetchStream: async (url) => ({
          finalUrl: url,
          response: new Response(sourceStream, {
            status: 200,
            headers: { 'Content-Type': 'video/mp4' },
          }),
        }),
        putBlob: async (pathname, body, options) => {
          capturedPuts.push({ pathname, body, options });
          return {
            url: 'https://abcstore.public.blob.vercel-storage.com/mirrors/frieren-alem-da-jornada/ep_mirror_test_01.mp4',
            pathname,
          };
        },
        saveMirrorSource: async (epId, blobUrl, opts) => {
          savedArgs = { episodeId: epId, blobUrl, force: opts.force };
          return {
            slot: 2,
            episode: {
              ...episode,
              video_url_2: blobUrl,
              source_kind_2: 'mp4',
              force_proxy_2: false,
              is_mirror_2: true,
            },
          };
        },
      }
    );

    const capturedPut = capturedPuts[0];
    expect(outcome.status).toBe(200);
    expect(outcome.body.ok).toBe(true);
    expect(capturedPut?.pathname).toBe('mirrors/frieren-alem-da-jornada/ep_mirror_test_01.mp4');
    expect(capturedPut?.body).toBe(sourceStream);
    expect(capturedPut?.options).toMatchObject({
      access: 'public',
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: 'video/mp4',
      multipart: true,
      token: 'vercel_blob_rw_test_token',
    });
    expect(savedArgs).toEqual({
      episodeId: episode.id,
      blobUrl:
        'https://abcstore.public.blob.vercel-storage.com/mirrors/frieren-alem-da-jornada/ep_mirror_test_01.mp4',
      force: false,
    });
  });

  it('4. aborta sem gravar nada quando R2 retorna 403 ou ExpiredRequest e responde "link vencido, pegue um novo no 1DM"', async () => {
    const episode = makePlayerEpisode();
    let putCalled = false;
    let saveCalled = false;

    const expiredXml =
      '<?xml version="1.0" encoding="UTF-8"?><Error><Code>ExpiredRequest</Code><Message>Request has expired</Message></Error>';

    for (const badResponse of [
      () => new Response(expiredXml, { status: 400, headers: { 'Content-Type': 'application/xml' } }),
      () => new Response('Forbidden', { status: 403 }),
    ]) {
      putCalled = false;
      saveCalled = false;

      const outcome = await mirrorEpisodeSource(
        {
          episodeId: episode.id,
          sourceUrl: 'https://bucket123.r2.cloudflarestorage.com/anime/ep01.mp4?X-Amz-Signature=old',
        },
        {
          isDbConfigured: () => true,
          blobToken: 'vercel_blob_rw_test_token',
          getEpisode: async () => episode,
          fetchStream: async (url) => ({ finalUrl: url, response: badResponse() }),
          putBlob: async () => {
            putCalled = true;
            return { url: 'https://store.public.blob.vercel-storage.com/x.mp4', pathname: 'x.mp4' };
          },
          saveMirrorSource: async () => {
            saveCalled = true;
            return { slot: 2, episode };
          },
        }
      );

      expect(outcome.status).toBe(403);
      expect(outcome.body).toEqual({
        ok: false,
        error: EXPIRED_MIRROR_LINK_MESSAGE,
      });
      expect(putCalled).toBe(false);
      expect(saveCalled).toBe(false);
    }

    expect(isExpiredUpstreamResponse(403, '')).toBe(true);
    expect(isExpiredUpstreamResponse(400, expiredXml)).toBe(true);
    expect(isExpiredUpstreamResponse(500, 'Internal Error')).toBe(false);
  });

  it('5. protege /api/mirror com autenticação admin (POST only + cookie assinado + mesma origem)', async () => {
    const prevSecret = process.env.PLAYER_SESSION_SECRET;
    process.env.PLAYER_SESSION_SECRET = 'test-secret-for-mirror-route-123456';

    try {
      const getReq = new Request('https://app.test/api/mirror', { method: 'GET' });
      expect((await handleMirrorRequest(getReq)).status).toBe(405);

      const unauthReq = new Request('https://app.test/api/mirror', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episodeId: 'ep1', sourceUrl: 'https://a.r2.cloudflarestorage.com/1.mp4' }),
      });
      expect((await handleMirrorRequest(unauthReq)).status).toBe(401);

      const token = createSessionToken();
      const crossOriginReq = new Request('https://app.test/api/mirror', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://evil.example',
          Cookie: `${ADMIN_SESSION_COOKIE_NAME}=${token}`,
        },
        body: JSON.stringify({ episodeId: 'ep1', sourceUrl: 'https://a.r2.cloudflarestorage.com/1.mp4' }),
      });
      expect((await handleMirrorRequest(crossOriginReq)).status).toBe(403);

      const badHostReq = new Request('https://app.test/api/mirror', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://app.test',
          Cookie: `${ADMIN_SESSION_COOKIE_NAME}=${token}`,
        },
        body: JSON.stringify({ episodeId: 'ep1', sourceUrl: 'https://untrusted.example.com/1.mp4' }),
      });
      const badHostRes = await handleMirrorRequest(badHostReq, {
        isDbConfigured: () => true,
        blobToken: 'vercel_blob_rw_test_token',
      });
      expect(badHostRes.status).toBe(403);
    } finally {
      process.env.PLAYER_SESSION_SECRET = prevSecret;
    }
  });

  it('6. bloqueia espelhamento duplicado salvo quando force=true e sobrescreve o slot existente', async () => {
    const mirroredEpisode = makePlayerEpisode({
      video_url_2: 'https://abcstore.public.blob.vercel-storage.com/mirrors/frieren-alem-da-jornada/ep_mirror_test_01.mp4',
      source_kind_2: 'mp4',
      force_proxy_2: false,
      is_mirror_2: true,
    });

    const blocked = await mirrorEpisodeSource(
      {
        episodeId: mirroredEpisode.id,
        sourceUrl: 'https://bucket123.r2.cloudflarestorage.com/ep01.mp4',
        force: false,
      },
      {
        isDbConfigured: () => true,
        blobToken: 'vercel_blob_rw_test_token',
        getEpisode: async () => mirroredEpisode,
      }
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body.ok).toBe(false);

    let executedQueries: string[] = [];
    const mockSql: DiagnosticSqlTag = async (strings) => {
      const query = strings.join(' ');
      executedQueries.push(query);
      if (query.trim().startsWith('SELECT')) {
        return [mirroredEpisode];
      }
      return [
        {
          ...mirroredEpisode,
          video_url_2:
            'https://abcstore.public.blob.vercel-storage.com/mirrors/frieren-alem-da-jornada/ep_mirror_test_01.mp4',
          source_kind_2: 'mp4',
          force_proxy_2: false,
          is_mirror_2: true,
        },
      ];
    };

    await expect(
      saveEpisodeMirrorSource(
        mirroredEpisode.id,
        'https://abcstore.public.blob.vercel-storage.com/mirrors/frieren-alem-da-jornada/ep_mirror_test_01.mp4',
        { force: false, sqlOverride: mockSql }
      )
    ).rejects.toThrow(/forçar refazer/i);

    const saved = await saveEpisodeMirrorSource(
      mirroredEpisode.id,
      'https://abcstore.public.blob.vercel-storage.com/mirrors/frieren-alem-da-jornada/ep_mirror_test_01.mp4',
      { force: true, sqlOverride: mockSql }
    );
    expect(saved.slot).toBe(2);
    expect(executedQueries.some((q) => q.includes('is_mirror_2 = true') && q.includes('force_proxy_2 = false'))).toBe(true);
  });

  it('7. bloqueia redirecionamento em safeFetchMirrorStream para host fora da allowlist', async () => {
    await expect(
      safeFetchMirrorStream('https://bucket123.r2.cloudflarestorage.com/video.mp4', {
        assertSafeUrl: async (raw) => new URL(raw),
        fetchImpl: async () =>
          new Response(null, {
            status: 302,
            headers: { Location: 'https://evil-redirect.example.com/video.mp4' },
          }),
      })
    ).rejects.toThrow(/não permitido/i);
  });

  it('8. player reproduz URL do Vercel Blob diretamente (needsProxy=false) e prioriza espelho sobre link expirante', () => {
    const blobUrl =
      'https://abcstore.public.blob.vercel-storage.com/mirrors/frieren/ep_01.mp4';
    expect(isVercelBlobUrl(blobUrl)).toBe(true);

    const norm = normalizeVideoSource(blobUrl, 2, 'mp4');
    expect(norm?.kind).toBe('mp4');
    expect(norm?.needsProxy).toBe(false);
    expect(norm?.isMirror).toBe(true);
    expect(norm?.resolvedUrl).toBe(blobUrl);

    const collected = collectEpisodeSources({
      video_url: 'https://anitube22.vip/playerricas.php?id=123',
      video_url_2: blobUrl,
      source_kind: 'iframe',
      source_kind_2: 'mp4',
      is_mirror_2: true,
    });

    expect(collected[0].slot).toBe(2);
    expect(collected[0].isMirror).toBe(true);
    expect(collected[0].needsProxy).toBe(false);
  });

  it('9. interface admin inclui selo "espelho", botão "Guardar cópia" e trava de "Forçar refazer"', () => {
    const adminSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/routes/admin.tsx'),
      'utf8'
    );
    expect(adminSource).toContain('Guardar cópia');
    expect(adminSource).toContain('espelho');
    expect(adminSource).toContain('Forçar refazer');
  });
});
