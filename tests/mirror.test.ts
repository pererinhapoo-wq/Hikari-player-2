import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADMIN_SESSION_COOKIE_NAME, createSessionToken } from '@/lib/auth';
import {
  type DiagnosticSqlTag,
  type PlayerEpisode,
  sanitizeEpisodeInput,
  saveEpisodeMirrorSource,
} from '@/lib/db';
import {
  buildMirrorBlobPathname,
  deriveMirrorSourceKind,
  EXPIRED_MIRROR_LINK_MESSAGE,
  handleMirrorRequest,
  INCOMPLETE_MIRROR_MESSAGE,
  isAllowedMirrorSourceHost,
  isExpiredUpstreamResponse,
  MAX_MIRROR_BYTES,
  MIRROR_CHUNK_BYTES,
  mirrorEpisodeSource,
  safeFetchMirrorStream,
  TOO_LARGE_MIRROR_MESSAGE,
} from '@/lib/mirror';
import { isAllowedProxyMediaUrl } from '@/lib/ssrf';
import {
  DIRECT_MEDIA_HOSTS as PROXY_DIRECT_MEDIA_HOSTS,
  isDirectMediaHost as isProxyDirectMediaHost,
  resolveUpstreamReferer,
} from '@/lib/stream-proxy';
import {
  collectEpisodeSources,
  DIRECT_MEDIA_HOSTS,
  isDirectMediaHost,
  isVercelBlobUrl,
  normalizeVideoSource,
} from '@/lib/video-sources';
import { splitSqlStatements } from '../scripts/migrate';

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

  it('3. faz streaming em partes com allowOverwrite, contentType video/mp4 e multipart sem carregar tudo em memória', async () => {
    const episode = makePlayerEpisode();
    const payloadBytes = new Uint8Array([0, 0, 0, 24]);
    const sourceStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payloadBytes);
        controller.close();
      },
    });

    const capturedPuts: Array<{
      pathname: string;
      receivedBytes: number;
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
            headers: {
              'Content-Type': 'video/mp4',
              'Content-Length': String(payloadBytes.byteLength),
            },
          }),
        }),
        putBlob: async (pathname, body, options) => {
          const buf = await new Response(body).arrayBuffer();
          capturedPuts.push({ pathname, receivedBytes: buf.byteLength, options });
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
    expect(capturedPut?.receivedBytes).toBe(payloadBytes.byteLength);
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

  it('10. inclui public.blob.vercel-storage.com nas allowlists de mídia direta (player e stream-proxy) sem Referer artificial', () => {
    const blobHost = 'q70piqtcusyiwtbz.public.blob.vercel-storage.com';
    const blobUrl = `https://${blobHost}/mirrors/sem-anime/PUsNxKDL5TunoQk-GZw74.mp4`;

    expect([...DIRECT_MEDIA_HOSTS]).toContain('public.blob.vercel-storage.com');
    expect([...PROXY_DIRECT_MEDIA_HOSTS]).toContain('public.blob.vercel-storage.com');
    expect(isDirectMediaHost(blobHost)).toBe(true);
    expect(isProxyDirectMediaHost(blobHost)).toBe(true);
    expect(isAllowedProxyMediaUrl(new URL(blobUrl))).toBe(true);
    expect(resolveUpstreamReferer(new URL(blobUrl))).toBe('');

    // Mesmo que explicitKind tenha sido gravado errado como 'hls' ou 'iframe', URL Blob força mp4 direto sem proxy
    const fromStaleHls = normalizeVideoSource(blobUrl, 1, 'hls');
    expect(fromStaleHls?.kind).toBe('mp4');
    expect(fromStaleHls?.needsProxy).toBe(false);
    expect(fromStaleHls?.resolvedUrl).toBe(blobUrl);

    const fromStaleIframe = normalizeVideoSource(blobUrl, 1, 'iframe');
    expect(fromStaleIframe?.kind).toBe('mp4');
    expect(fromStaleIframe?.needsProxy).toBe(false);
  });

  it('11. /api/mirror deriva kind da extensão (nunca "auto") e grava source_kind="mp4" e force_proxy=false', async () => {
    expect(
      deriveMirrorSourceKind(
        'https://q70piqtcusyiwtbz.public.blob.vercel-storage.com/mirrors/sem-anime/PUsNxKDL5TunoQk-GZw74.mp4'
      )
    ).toBe('mp4');
    expect(deriveMirrorSourceKind('mirrors/sem-anime/ep.mp4')).toBe('mp4');

    const episode = makePlayerEpisode({ id: 'PUsNxKDL5TunoQk-GZw74' });
    let capturedSaveOpts: Record<string, unknown> | null = null;

    const outcome = await mirrorEpisodeSource(
      {
        episodeId: episode.id,
        sourceUrl: 'https://bucket123.r2.cloudflarestorage.com/anime/ep.mp4?X-Amz-Signature=ok',
        force: false,
      },
      {
        isDbConfigured: () => true,
        blobToken: 'vercel_blob_rw_test_token',
        getEpisode: async () => episode,
        fetchStream: async (url) => ({
          finalUrl: url,
          response: new Response(new Uint8Array([0, 0, 0, 24]), {
            status: 200,
            headers: {
              'Content-Type': 'video/mp4',
              'Content-Length': '4',
            },
          }),
        }),
        putBlob: async (pathname, body) => {
          await new Response(body).arrayBuffer();
          return {
            url: `https://q70piqtcusyiwtbz.public.blob.vercel-storage.com/${pathname}`,
            pathname,
          };
        },
        saveMirrorSource: async (_epId, blobUrl, opts) => {
          capturedSaveOpts = { ...opts };
          return {
            slot: 2,
            episode: {
              ...episode,
              video_url_2: blobUrl,
              source_kind_2: opts.kind ?? 'mp4',
              force_proxy_2: Boolean(opts.forceProxy),
              is_mirror_2: true,
            },
          };
        },
      }
    );

    expect(outcome.status).toBe(200);
    expect(capturedSaveOpts).toEqual({
      force: false,
      kind: 'mp4',
      forceProxy: false,
    });

    // sanitizeEpisodeInput também nunca deixa Blob com kind=null ("auto") nem force_proxy=true
    const sanitized = sanitizeEpisodeInput({
      anime_name: 'Teste',
      episode_number: '01',
      title: 'Ep 01',
      poster_url: 'https://cdn.example.com/poster.jpg',
      video_url:
        'https://q70piqtcusyiwtbz.public.blob.vercel-storage.com/mirrors/sem-anime/PUsNxKDL5TunoQk-GZw74.mp4',
      source_kind: '',
      force_proxy: true,
    });
    expect(sanitized.source_kind).toBe('mp4');
    expect(sanitized.force_proxy).toBe(false);
  });

  it('12. player renderiza <video> nativo com playsInline, preload="metadata" e src direto para Blob (sem hls.js e sem proxy)', () => {
    const playerSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/EpisodePlayer.tsx'),
      'utf8'
    );

    expect(playerSource).toContain("mode: 'video'");
    expect(playerSource).toContain('isDirectMediaUrl(source.resolvedUrl)');
    expect(playerSource).toContain('isVercelBlobUrl(source.resolvedUrl)');
    expect(playerSource).toMatch(
      /<video[\s\S]*?src=\{resolvedRuntime\.mode === 'video' \? resolvedRuntime\.url : undefined\}[\s\S]*?playsInline[\s\S]*?preload="metadata"/
    );
  });

  it('13. migration 0007 corrige episódio PUsNxKDL5TunoQk-GZw74 para mp4 e force_proxy=false com SQL válido', () => {
    const migrationSql = fs.readFileSync(
      path.resolve(process.cwd(), 'migrations/0007_fix_blob_mirrors_mp4.sql'),
      'utf8'
    );
    expect(migrationSql).toContain('PUsNxKDL5TunoQk-GZw74');
    expect(migrationSql).toContain('public.blob.vercel-storage.com');
    expect(migrationSql).toContain("THEN 'mp4'");
    expect(migrationSql).toContain('THEN false');

    const statements = splitSqlStatements(migrationSql);
    expect(statements).toHaveLength(1);
  });

  it('14. recusa arquivos acima de 400 MB antes de enviar com "arquivo grande demais para cópia"', async () => {
    const episode = makePlayerEpisode();
    let putCalled = false;
    let saveCalled = false;
    let canceled = false;

    const oversizedBody = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    });

    const outcome = await mirrorEpisodeSource(
      {
        episodeId: episode.id,
        sourceUrl: 'https://bucket123.r2.cloudflarestorage.com/anime/huge.mp4',
      },
      {
        isDbConfigured: () => true,
        blobToken: 'vercel_blob_rw_test_token',
        getEpisode: async () => episode,
        fetchStream: async (url) => ({
          finalUrl: url,
          response: new Response(oversizedBody, {
            status: 206,
            headers: {
              'Content-Type': 'video/mp4',
              'Content-Length': String(MIRROR_CHUNK_BYTES),
              'Content-Range': `bytes 0-${MIRROR_CHUNK_BYTES - 1}/${MAX_MIRROR_BYTES + 1}`,
            },
          }),
        }),
        putBlob: async () => {
          putCalled = true;
          return { url: 'https://abc.public.blob.vercel-storage.com/x.mp4', pathname: 'x.mp4' };
        },
        saveMirrorSource: async () => {
          saveCalled = true;
          return { slot: 2, episode };
        },
      }
    );

    expect(outcome.status).toBe(413);
    expect(outcome.body).toEqual({
      ok: false,
      error: TOO_LARGE_MIRROR_MESSAGE,
    });
    expect(canceled).toBe(true);
    expect(putCalled).toBe(false);
    expect(saveCalled).toBe(false);
  });

  it('15. baixa e envia em partes de 8 MB usando Range na origem e put com multipart: true e contentType video/mp4', async () => {
    const episode = makePlayerEpisode();
    const totalBytes = MIRROR_CHUNK_BYTES * 2 + 12345; // ~16.01 MB -> 3 partes (8MB, 8MB, 12345B)
    const fullBuffer = new Uint8Array(totalBytes);
    for (let i = 0; i < totalBytes; i++) {
      fullBuffer[i] = i % 251;
    }

    const requestedRanges: Array<string | undefined> = [];
    let uploadedBuffer: Uint8Array = new Uint8Array(0);
    let capturedOptions: Record<string, unknown> | null = null;

    const outcome = await mirrorEpisodeSource(
      {
        episodeId: episode.id,
        sourceUrl: 'https://bucket123.r2.cloudflarestorage.com/anime/ep02.mp4',
      },
      {
        isDbConfigured: () => true,
        blobToken: 'vercel_blob_rw_test_token',
        getEpisode: async () => episode,
        fetchStream: async (url, opts) => {
          requestedRanges.push(opts?.range);
          const match = /^bytes=(\d+)-(\d+)$/.exec(opts?.range ?? '');
          expect(match).not.toBeNull();
          const start = Number(match![1]);
          const end = Math.min(Number(match![2]), totalBytes - 1);
          const slice = fullBuffer.subarray(start, end + 1);
          return {
            finalUrl: url,
            response: new Response(slice, {
              status: 206,
              headers: {
                'Content-Type': 'video/mp4',
                'Content-Length': String(slice.byteLength),
                'Content-Range': `bytes ${start}-${end}/${totalBytes}`,
              },
            }),
          };
        },
        putBlob: async (pathname, body, opts) => {
          capturedOptions = opts;
          uploadedBuffer = new Uint8Array(await new Response(body).arrayBuffer());
          return {
            url: `https://abc.public.blob.vercel-storage.com/${pathname}`,
            pathname,
          };
        },
        saveMirrorSource: async (_epId, blobUrl, opts) => ({
          slot: 2,
          episode: {
            ...episode,
            video_url_2: blobUrl,
            source_kind_2: opts.kind ?? 'mp4',
            force_proxy_2: Boolean(opts.forceProxy),
            is_mirror_2: true,
          },
        }),
      }
    );

    expect(outcome.status).toBe(200);
    expect(outcome.body.ok).toBe(true);
    expect(requestedRanges).toEqual([
      `bytes=0-${MIRROR_CHUNK_BYTES - 1}`,
      `bytes=${MIRROR_CHUNK_BYTES}-${MIRROR_CHUNK_BYTES * 2 - 1}`,
      `bytes=${MIRROR_CHUNK_BYTES * 2}-${totalBytes - 1}`,
    ]);
    expect(capturedOptions).toMatchObject({
      multipart: true,
      contentType: 'video/mp4',
    });
    expect(uploadedBuffer.byteLength).toBe(totalBytes);
    expect(uploadedBuffer[0]).toBe(fullBuffer[0]);
    expect(uploadedBuffer[totalBytes - 1]).toBe(fullBuffer[totalBytes - 1]);
  });

  it('16. se bytes enviados divergirem do content-length, apaga o blob, nunca grava no banco e responde "cópia incompleta, tente de novo"', async () => {
    const episode = makePlayerEpisode();
    const deletedTargets: string[] = [];
    let saveCalled = false;

    const declaredLength = 1024;
    const truncatedBytes = new Uint8Array(512);

    const outcome = await mirrorEpisodeSource(
      {
        episodeId: episode.id,
        sourceUrl: 'https://bucket123.r2.cloudflarestorage.com/anime/truncated.mp4',
      },
      {
        isDbConfigured: () => true,
        blobToken: 'vercel_blob_rw_test_token',
        getEpisode: async () => episode,
        fetchStream: async (url) => ({
          finalUrl: url,
          response: new Response(truncatedBytes, {
            status: 200,
            headers: {
              'Content-Type': 'video/mp4',
              'Content-Length': String(declaredLength),
            },
          }),
        }),
        putBlob: async (pathname, body) => {
          await new Response(body).arrayBuffer();
          return {
            url: `https://abc.public.blob.vercel-storage.com/${pathname}`,
            pathname,
          };
        },
        delBlob: async (target) => {
          deletedTargets.push(...(Array.isArray(target) ? target : [target]));
        },
        saveMirrorSource: async () => {
          saveCalled = true;
          return { slot: 2, episode };
        },
      }
    );

    expect(outcome.status).toBe(502);
    expect(outcome.body).toEqual({
      ok: false,
      error: INCOMPLETE_MIRROR_MESSAGE,
    });
    expect(deletedTargets).toContain(
      'https://abc.public.blob.vercel-storage.com/mirrors/frieren-alem-da-jornada/ep_mirror_test_01.mp4'
    );
    expect(saveCalled).toBe(false);
  });

  it('17. se o tempo acabar antes do fim, aborta upload, apaga o blob parcial e não grava no banco', async () => {
    const episode = makePlayerEpisode();
    const deletedTargets: string[] = [];
    let saveCalled = false;

    const slowStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        controller.enqueue(new Uint8Array(1024));
      },
    });

    const outcome = await mirrorEpisodeSource(
      {
        episodeId: episode.id,
        sourceUrl: 'https://bucket123.r2.cloudflarestorage.com/anime/slow.mp4',
      },
      {
        isDbConfigured: () => true,
        blobToken: 'vercel_blob_rw_test_token',
        maxDurationMs: 25,
        getEpisode: async () => episode,
        fetchStream: async (url) => ({
          finalUrl: url,
          response: new Response(slowStream, {
            status: 200,
            headers: {
              'Content-Type': 'video/mp4',
              'Content-Length': String(10 * 1024 * 1024),
            },
          }),
        }),
        putBlob: async (pathname, body, opts) => {
          await new Promise<void>((resolve, reject) => {
            opts.abortSignal?.addEventListener('abort', () => {
              reject(new Error('Aborted due to timeout'));
            });
            void new Response(body).arrayBuffer().then(() => resolve(), reject);
          });
          return {
            url: `https://abc.public.blob.vercel-storage.com/${pathname}`,
            pathname,
          };
        },
        delBlob: async (target) => {
          deletedTargets.push(...(Array.isArray(target) ? target : [target]));
        },
        saveMirrorSource: async () => {
          saveCalled = true;
          return { slot: 2, episode };
        },
      }
    );

    expect(outcome.status).toBe(504);
    expect(outcome.body).toEqual({
      ok: false,
      error: INCOMPLETE_MIRROR_MESSAGE,
    });
    expect(deletedTargets).toContain('mirrors/frieren-alem-da-jornada/ep_mirror_test_01.mp4');
    expect(saveCalled).toBe(false);
  });

  it('18. configura maxDuration no máximo do plano em vite.config.ts para /api/mirror', () => {
    const viteConfig = fs.readFileSync(path.resolve(process.cwd(), 'vite.config.ts'), 'utf8');
    expect(viteConfig).toMatch(/['"]\/api\/mirror['"]\s*:\s*\{[\s\S]*?maxDuration\s*:\s*['"]max['"]/);
  });
});
