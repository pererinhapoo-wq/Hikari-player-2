import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canUseDirectMaximaimgFallback,
  classifyHlsError,
  decideHlsErrorAction,
} from '@/lib/hls-playback';
import {
  buildSignedProxyPath,
  createProxyExpirableSignature,
  createProxyRefererSignature,
  MAX_HLS_REWRITE_DEPTH,
  rewriteM3u8Playlist,
} from '@/lib/proxy-signing';
import { diagnoseEpisodeSources, diagnoseVideoSource } from '@/lib/source-diagnostics';
import {
  clearLearnedRefererCache,
  getUpstreamHeaders,
  handleProxyStreamRequest,
  LEARNED_REFERER_TTL_SECONDS,
  type LearnedRefererStore,
  resolveUpstreamReferer,
  resolveUpstreamRefererCandidates,
} from '@/lib/stream-proxy';
import type { PlayableSource } from '@/lib/types';
import {
  collectEpisodeSources,
  describeExpirableHlsTokens,
  extractExpirableTokenRemainingSeconds,
  getNextFallbackSourceIndex,
  hasExpirableHlsTokens,
  isExpirableHlsSourceUrl,
  normalizeVideoSource,
} from '@/lib/video-sources';

const MAXIMAIMG_TEST_URL =
  'https://cdn-sv01.maximaimg.online/stream/b/bakemonogatari/01.mp4/index.m3u8';

function toPlayable(rawUrl: string, slot: 1 | 2 | 3 | 4 | 5): PlayableSource {
  const norm = normalizeVideoSource(rawUrl, slot);
  if (!norm) throw new Error(`Fonte inválida no teste: ${rawUrl}`);
  return {
    ...norm,
    playUrl: norm.needsProxy ? buildSignedProxyPath(norm.resolvedUrl) : norm.resolvedUrl,
  };
}

describe('Reprodução HLS Maximaimg, Fallback Direto, Proxy e Segurança', () => {
  beforeEach(() => {
    process.env.PLAYER_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
    clearLearnedRefererCache();
  });

  it('1. identifica corretamente o endereço Maximaimg (mesmo contendo /01.mp4/ no caminho) como HLS', () => {
    const source = normalizeVideoSource(MAXIMAIMG_TEST_URL, 1);
    expect(source).not.toBeNull();
    expect(source?.kind).toBe('hls');
    expect(source?.provider).toBe('maximaimg');
    expect(source?.needsProxy).toBe(true);
    expect(source?.resolvedUrl).toBe(MAXIMAIMG_TEST_URL);
    expect(source?.formatLabel).toBe('Maximaimg · HLS');
  });

  it('2. permite fallback do proxy para URL direta SOMENTE em fontes Maximaimg HLS', () => {
    const maxHls = toPlayable(MAXIMAIMG_TEST_URL, 1);
    const maxMp4 = toPlayable('https://cdn-sv01.maximaimg.online/files/ep01.mp4', 2);
    const genericHls = toPlayable('https://cdn.example.com/hls/master.m3u8', 3);
    const mp4 = toPlayable('https://cdn.example.com/video/ep01.mp4', 4);
    const webm = toPlayable('https://cdn.example.com/video/ep01.webm', 5);
    const iframe = toPlayable('https://embeds.example.com/watch/1.html', 1);

    const diagnostic403 = classifyHlsError({
      type: 'networkError',
      details: 'manifestLoadError',
      httpCode: 403,
      url: maxHls.playUrl,
    });
    expect(diagnostic403.category).toBe('auth_forbidden');

    // Maximaimg HLS em estratégia proxy com HTTP 403 -> aciona fallback direto sem repetir startLoad
    const maxHlsDecision = decideHlsErrorAction({
      source: maxHls,
      strategy: 'proxy',
      alreadyAttemptedDirect: false,
      networkRetriesUsed: 0,
      mediaRecoveriesUsed: 0,
      diagnostic: diagnostic403,
    });
    expect(maxHlsDecision.action).toBe('fallback_direct');

    // Demais fontes NÃO podem fazer fallback direto via política Maximaimg
    expect(canUseDirectMaximaimgFallback(maxMp4, 'proxy', false)).toBe(false);
    expect(canUseDirectMaximaimgFallback(genericHls, 'proxy', false)).toBe(false);
    expect(canUseDirectMaximaimgFallback(mp4, 'proxy', false)).toBe(false);
    expect(canUseDirectMaximaimgFallback(webm, 'proxy', false)).toBe(false);
    expect(canUseDirectMaximaimgFallback(iframe, 'proxy', false)).toBe(false);

    const genericDecision = decideHlsErrorAction({
      source: genericHls,
      strategy: 'direct',
      alreadyAttemptedDirect: false,
      networkRetriesUsed: 0,
      mediaRecoveriesUsed: 0,
      diagnostic: diagnostic403,
    });
    expect(genericDecision.action).toBe('failover');
  });

  it('3. garante ausência de loop entre proxy e URL direta após a tentativa única', () => {
    const maxHls = toPlayable(MAXIMAIMG_TEST_URL, 1);

    // Uma vez em strategy='direct' (ou alreadyAttemptedDirect=true), jamais volta para fallback_direct nem proxy
    expect(canUseDirectMaximaimgFallback(maxHls, 'direct', true)).toBe(false);
    expect(canUseDirectMaximaimgFallback(maxHls, 'proxy', true)).toBe(false);

    const corsFailure = classifyHlsError({
      type: 'networkError',
      details: 'manifestLoadError',
      httpCode: 0,
      url: maxHls.resolvedUrl,
    });

    // 1ª falha de rede transitória na tentativa direta permite no máximo 1 retry controlado
    const firstDirectFail = decideHlsErrorAction({
      source: maxHls,
      strategy: 'direct',
      alreadyAttemptedDirect: true,
      networkRetriesUsed: 0,
      mediaRecoveriesUsed: 0,
      diagnostic: corsFailure,
    });
    expect(firstDirectFail.action).toBe('retry_load');

    // Após esgotar o retry controlado, vai obrigatoriamente para failover (sem loop)
    const secondDirectFail = decideHlsErrorAction({
      source: maxHls,
      strategy: 'direct',
      alreadyAttemptedDirect: true,
      networkRetriesUsed: 1,
      mediaRecoveriesUsed: 0,
      diagnostic: corsFailure,
    });
    expect(secondDirectFail.action).toBe('failover');
  });

  it('4. avança para failover dos slots 2–5 quando proxy e acesso direto falham', () => {
    const sources = collectEpisodeSources({
      video_url: MAXIMAIMG_TEST_URL,
      video_url_2: 'https://cdn.example.com/backup/ep01.mp4',
      video_url_3: 'https://embeds.example.com/e/ep01',
    });

    const slot1 = toPlayable(MAXIMAIMG_TEST_URL, 1);
    const direct403 = classifyHlsError({
      type: 'networkError',
      details: 'manifestLoadError',
      httpCode: 403,
      url: slot1.resolvedUrl,
    });

    const actionAfterDirectFail = decideHlsErrorAction({
      source: slot1,
      strategy: 'direct',
      alreadyAttemptedDirect: true,
      networkRetriesUsed: 0,
      mediaRecoveriesUsed: 0,
      diagnostic: direct403,
    });
    expect(actionAfterDirectFail.action).toBe('failover');

    const failed = new Set<number>([1]);
    const nextIdx = getNextFallbackSourceIndex(sources, 0, failed);
    expect(nextIdx).toBe(1);
    expect(sources[nextIdx!].slot).toBe(2);
  });

  it('5. preserva URLs relativas, absolutas, query parameters e playlists secundárias na reescrita M3U8', () => {
    const masterM3u8 = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720',
      '720p/index.m3u8?token=abc123&hd=1',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480',
      'https://edge.maximaimg.online/480p/index.m3u8?auth=xyz',
    ].join('\n');

    const rewritten = rewriteM3u8Playlist(
      masterM3u8,
      MAXIMAIMG_TEST_URL,
      (resolved) => `/api/proxy/stream?url=${encodeURIComponent(resolved)}`
    );

    expect(rewritten).toContain(
      '/api/proxy/stream?url=https%3A%2F%2Fcdn-sv01.maximaimg.online%2Fstream%2Fb%2Fbakemonogatari%2F01.mp4%2F720p%2Findex.m3u8%3Ftoken%3Dabc123%26hd%3D1'
    );
    expect(rewritten).toContain(
      '/api/proxy/stream?url=https%3A%2F%2Fedge.maximaimg.online%2F480p%2Findex.m3u8%3Fauth%3Dxyz'
    );
  });

  it('6. reescreve atributos URI com aspas simples e duplas em tags #EXT-X-KEY e #EXT-X-MAP', () => {
    const playlist = [
      '#EXTM3U',
      "#EXT-X-KEY:METHOD=AES-128,URI='keys/secret.key?k=1'",
      '#EXT-X-MAP:URI="init/segment.mp4?v=2"',
      "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID='aac',NAME='JP',URI='audio/jp.m3u8'",
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://fairplay-key"',
      '#EXTINF:6.0,',
      'seg-001.ts',
    ].join('\n');

    const rewritten = rewriteM3u8Playlist(
      playlist,
      MAXIMAIMG_TEST_URL,
      (resolved) => `/api/proxy/stream?url=${encodeURIComponent(resolved)}`
    );

    expect(rewritten).toContain(
      "#EXT-X-KEY:METHOD=AES-128,URI='/api/proxy/stream?url=https%3A%2F%2Fcdn-sv01.maximaimg.online%2Fstream%2Fb%2Fbakemonogatari%2F01.mp4%2Fkeys%2Fsecret.key%3Fk%3D1'"
    );
    expect(rewritten).toContain(
      '#EXT-X-MAP:URI="/api/proxy/stream?url=https%3A%2F%2Fcdn-sv01.maximaimg.online%2Fstream%2Fb%2Fbakemonogatari%2F01.mp4%2Finit%2Fsegment.mp4%3Fv%3D2"'
    );
    expect(rewritten).toContain(
      "URI='/api/proxy/stream?url=https%3A%2F%2Fcdn-sv01.maximaimg.online%2Fstream%2Fb%2Fbakemonogatari%2F01.mp4%2Faudio%2Fjp.m3u8'"
    );
    expect(rewritten).toContain('URI="skd://fairplay-key"');
  });

  it('7. preserva integralmente bytes binários mesmo quando a origem responde Content-Type: text/plain', async () => {
    // Bytes inválidos em UTF-8 (0xff, 0xfe, 0x80) + sync byte MPEG-TS (0x47)
    const rawBinary = new Uint8Array([0x47, 0x40, 0x00, 0xff, 0xfe, 0x80, 0x9f, 0x00, 0x11, 0x22, 0xc3, 0x28]);
    const signedPath = buildSignedProxyPath('https://cdn-sv01.maximaimg.online/stream/b/ep01/seg-001.ts');

    const response = await handleProxyStreamRequest(
      new Request(`http://localhost${signedPath}`),
      {
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(rawBinary, {
            status: 200,
            headers: {
              'content-type': 'text/plain; charset=utf-8',
              'content-length': String(rawBinary.byteLength),
            },
          }),
        }),
      }
    );

    expect(response.status).toBe(200);
    const received = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(received)).toEqual(Array.from(rawBinary));
  });

  it('8. preserva cabeçalho Range, HTTP 206, Content-Range e Accept-Ranges no proxy', async () => {
    const partialChunk = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    const signedPath = buildSignedProxyPath('https://cdn-sv01.maximaimg.online/files/ep01.mp4');
    let capturedRange: string | undefined;

    const response = await handleProxyStreamRequest(
      new Request(`http://localhost${signedPath}`, {
        headers: { Range: 'bytes=0-7' },
      }),
      {
        fetchWithRedirects: async (url, options) => {
          capturedRange = options?.headers?.['Range'];
          return {
            finalUrl: url,
            response: new Response(partialChunk, {
              status: 206,
              headers: {
                'content-type': 'video/mp4',
                'content-length': '8',
                'content-range': 'bytes 0-7/1024',
                'accept-ranges': 'bytes',
              },
            }),
          };
        },
      }
    );

    expect(capturedRange).toBe('bytes=0-7');
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-7/1024');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-length')).toBe('8');
    const received = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(received)).toEqual(Array.from(partialChunk));
  });

  it('9. aplica troca de velocidade em efeito separado sem playbackRate nas dependências de montagem do HLS.js', () => {
    const playerSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/EpisodePlayer.tsx'),
      'utf8'
    );

    // Verifica que o efeito que monta o HLS.js depende apenas de [hasStarted, resolvedRuntime, cleanupHls]
    const mountEffectMatch = playerSource.match(
      /void attachHls\(\);[\s\S]*?\}, \[([^\]]+)\]\);/
    );
    expect(mountEffectMatch).not.toBeNull();
    const mountDeps = mountEffectMatch![1];
    expect(mountDeps).not.toContain('playbackRate');
    expect(mountDeps).toContain('resolvedRuntime');

    // Verifica efeito dedicado aplicando video.playbackRate = playbackRate sem desmontar HLS
    expect(playerSource).toMatch(
      /video\.playbackRate\s*=\s*playbackRate[\s\S]*?\}, \[playbackRate, resolvedRuntime\]\);/
    );
  });

  it('10. mantém proteção SSRF, assinatura inválida/expirada e não aceita Referer/Origin arbitrários do cliente', async () => {
    // 10a. Assinatura adulterada -> 403 sem chamar fetch externo
    const fetchSpy = vi.fn();
    const signedPath = buildSignedProxyPath(MAXIMAIMG_TEST_URL, 600);
    const tamperedUrl = new URL(`http://localhost${signedPath}`);
    tamperedUrl.searchParams.set('sig', 'assinatura-adulterada');

    const badSigRes = await handleProxyStreamRequest(new Request(tamperedUrl.toString()), {
      fetchWithRedirects: fetchSpy,
    });
    expect(badSigRes.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();

    // 10b. Assinatura expirada -> 403 sem chamar fetch externo
    const expiredPath = buildSignedProxyPath(MAXIMAIMG_TEST_URL, -60);
    const expiredRes = await handleProxyStreamRequest(
      new Request(`http://localhost${expiredPath}`),
      { fetchWithRedirects: fetchSpy }
    );
    expect(expiredRes.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();

    // 10c. Destino localhost/privado assinado hipoteticamente -> bloqueado pelo SSRF real (502)
    const internalSigned = buildSignedProxyPath('http://127.0.0.1:8080/internal.m3u8', 600);
    const ssrfRes = await handleProxyStreamRequest(
      new Request(`http://localhost${internalSigned}`)
    );
    expect(ssrfRes.status).toBe(502);
    expect(await ssrfRes.text()).toMatch(/privado|reservado|bloqueado/i);

    // 10d. Referer/Origin enviados pelo cliente não são repassados ao upstream
    const clientReq = new Request(`http://localhost${signedPath}`, {
      headers: {
        Referer: 'https://evil-client.example.com/',
        Origin: 'https://evil-client.example.com',
        Range: 'bytes=0-100',
      },
    });
    const upstreamHeaders = getUpstreamHeaders(new URL(MAXIMAIMG_TEST_URL), clientReq);
    expect(upstreamHeaders['Referer']).toBe('https://www.anitube.biz/');
    expect(upstreamHeaders['Origin']).toBeUndefined();
    expect(upstreamHeaders['Range']).toBe('bytes=0-100');
  });

  it('11. aplica mapa de Referer (https://www.anitube.biz/ para mywallpaper-4k-image.net com fallback sem referer) sem nunca enviar Origin', () => {
    const wallpaperReq = new Request('http://localhost/api/proxy/stream');
    const wallpaperHeaders = getUpstreamHeaders(
      new URL('https://cdn-s01.mywallpaper-4k-image.net/stream/01/index.m3u8'),
      wallpaperReq
    );
    expect(wallpaperHeaders['Referer']).toBe('https://www.anitube.biz/');
    expect(wallpaperHeaders['Origin']).toBeUndefined();
    expect(wallpaperHeaders['User-Agent']).toContain('Chrome/');

    const genericHeaders = getUpstreamHeaders(
      new URL('https://cdn.outroprovedor.com/video/ep1.mp4'),
      wallpaperReq
    );
    expect(genericHeaders['Referer']).toBe('https://cdn.outroprovedor.com/');
    expect(genericHeaders['Origin']).toBeUndefined();
  });

  it('12. faz pass-through binário de segmento .webp contendo video/MP2T (200 e 206 Range) e reescreve URIs relativas .webp no manifesto', async () => {
    const manifestUrl = 'https://cdn-s01.mywallpaper-4k-image.net/stream/anime/01/index.m3u8';
    const rawM3u8 = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:6',
      '#EXTINF:6.0,',
      'seg-001.webp',
      '#EXTINF:6.0,',
      '720p/seg-002.webp?tok=1',
      '#EXT-X-ENDLIST',
    ].join('\n');

    const signedManifest = buildSignedProxyPath(manifestUrl);
    const manifestRes = await handleProxyStreamRequest(
      new Request(`http://localhost${signedManifest}`),
      {
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(rawM3u8, {
            status: 200,
            headers: { 'content-type': 'application/vnd.apple.mpegurl' },
          }),
        }),
      }
    );
    expect(manifestRes.status).toBe(200);
    const rewrittenBody = await manifestRes.text();
    expect(rewrittenBody).toContain(
      encodeURIComponent('https://cdn-s01.mywallpaper-4k-image.net/stream/anime/01/seg-001.webp')
    );
    expect(rewrittenBody).toContain(
      encodeURIComponent('https://cdn-s01.mywallpaper-4k-image.net/stream/anime/01/720p/seg-002.webp?tok=1')
    );

    // Segmento .webp com MPEG-TS (sync byte 0x47) servido como image/webp pela CDN
    const tsBytes = new Uint8Array([0x47, 0x40, 0x00, 0x10, 0xff, 0xfe, 0x80, 0x01, 0x02, 0x03]);
    const segUrl = 'https://cdn-s01.mywallpaper-4k-image.net/stream/anime/01/seg-001.webp';
    const signedSeg = buildSignedProxyPath(segUrl);

    const seg200 = await handleProxyStreamRequest(
      new Request(`http://localhost${signedSeg}`),
      {
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(tsBytes, {
            status: 200,
            headers: {
              'content-type': 'image/webp',
              'content-length': String(tsBytes.byteLength),
            },
          }),
        }),
      }
    );
    expect(seg200.status).toBe(200);
    expect(seg200.headers.get('content-type')).toBe('video/mp2t');
    expect(seg200.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Array.from(new Uint8Array(await seg200.arrayBuffer()))).toEqual(Array.from(tsBytes));

    // Requisição com Range -> 206
    const seg206 = await handleProxyStreamRequest(
      new Request(`http://localhost${signedSeg}`, { headers: { Range: 'bytes=0-3' } }),
      {
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(tsBytes.slice(0, 4), {
            status: 206,
            headers: {
              'content-type': 'image/webp',
              'content-length': '4',
              'content-range': 'bytes 0-3/10',
              'accept-ranges': 'bytes',
            },
          }),
        }),
      }
    );
    expect(seg206.status).toBe(206);
    expect(seg206.headers.get('content-type')).toBe('video/mp2t');
    expect(seg206.headers.get('content-range')).toBe('bytes 0-3/10');
    expect(Array.from(new Uint8Array(await seg206.arrayBuffer()))).toEqual(Array.from(tsBytes.slice(0, 4)));
  });

  it('13. classifica corretamente fontes no diagnóstico do servidor (maximaimg, mywallpaper-4k-image, direto ok e bloqueado)', async () => {
    const reports = await diagnoseEpisodeSources(
      [
        {
          slot: 1,
          url: 'https://cdn-sv01.maximaimg.online/stream/b/ep01/index.m3u8',
        },
        {
          slot: 2,
          url: 'https://cdn-s01.mywallpaper-4k-image.net/stream/ep01/index.m3u8',
        },
        {
          slot: 3,
          url: 'https://cdn.cors-ok.example.com/ep01/index.m3u8',
        },
        {
          slot: 4,
          url: 'https://cdn.dead.example.com/ep01/index.m3u8',
        },
      ],
      {
        fetchWithRedirects: async (url, options) => {
          const headers = options?.headers ?? {};
          const hasUa = Boolean(headers['User-Agent']);
          const referer = headers['Referer'];

          if (url.includes('maximaimg.online')) {
            if (referer === 'https://www.anitube.biz/' && hasUa) {
              return {
                finalUrl: url,
                response: new Response('#EXTM3U\n#EXT-X-VERSION:3\nseg1.ts', {
                  status: 200,
                  headers: { 'content-type': 'application/vnd.apple.mpegurl' },
                }),
              };
            }
            return { finalUrl: url, response: new Response('Forbidden', { status: 403 }) };
          }

          if (url.includes('mywallpaper-4k-image.net')) {
            if (referer === 'https://www.anitube.biz/' && hasUa) {
              return {
                finalUrl: url,
                response: new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\nseg1.webp', {
                  status: 200,
                  headers: { 'content-type': 'application/vnd.apple.mpegurl' },
                }),
              };
            }
            return { finalUrl: url, response: new Response('Forbidden', { status: 403 }) };
          }

          if (url.includes('cors-ok.example.com')) {
            return {
              finalUrl: url,
              response: new Response('#EXTM3U\nseg1.ts', {
                status: 200,
                headers: {
                  'content-type': 'application/vnd.apple.mpegurl',
                  'access-control-allow-origin': '*',
                },
              }),
            };
          }

          return { finalUrl: url, response: new Response('Forbidden', { status: 403 }) };
        },
      }
    );

    expect(reports).toHaveLength(4);
    expect(reports[0].verdictLabel).toBe('proxy necessário');
    expect(reports[0].noHeaders.status).toBe(403);
    expect(reports[0].withHeaders.status).toBe(200);
    expect(reports[0].withHeaders.sentReferer).toBe('https://www.anitube.biz/');
    expect(reports[0].withHeaders.firstLine).toBe('#EXTM3U');

    expect(reports[1].verdictLabel).toBe('proxy necessário');
    expect(reports[1].noHeaders.status).toBe(403); // mywallpaper now tries anitube.biz first (mocked 403 or success)
    expect(reports[1].withHeaders.status).toBe(200);
    expect(reports[1].withHeaders.sentReferer).toBe('https://www.anitube.biz/');
    expect(reports[1].withHeaders.firstLine).toBe('#EXTM3U');

    expect(reports[2].verdictLabel).toBe('direto ok');
    expect(reports[2].noHeaders.accessControlAllowOrigin).toBe('*');

    expect(reports[3].verdictLabel).toBe('bloqueado');
    expect(reports[3].withHeaders.status).toBe(403);

    // Fonte iframe exige /api/embed para proxied host
    const iframeReport = await diagnoseVideoSource(
      { slot: 5, url: 'https://anitube.biz/playerricas.php?name=1.mp4' },
      {
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response('Forbidden', { status: 403 }),
        }),
        embedFetchImpl: async () =>
          new Response('<!doctype html><html></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
        embedAssertSafeUrl: async (raw: string) => new URL(raw),
      }
    );
    expect(iframeReport.detectedKind).toBe('iframe');
    expect(iframeReport.verdictLabel).toBe('proxy necessário');
  });

  it('14. no "Testar fonte", aprova HTTP 200 com content-type de vídeo e reprova HTTP 200 com text/html', async () => {
    const blobMp4Report = await diagnoseVideoSource(
      {
        slot: 1,
        url: 'https://q70piqtcusyiwtbz.public.blob.vercel-storage.com/mirrors/sem-anime/PUsNxKDL5TunoQk-GZw74.mp4',
      },
      {
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(new Uint8Array([0, 0, 0, 24]), {
            status: 200,
            headers: {
              'content-type': 'video/mp4',
            },
          }),
        }),
      }
    );

    expect(blobMp4Report.detectedKind).toBe('mp4');
    expect(blobMp4Report.verdict).toBe('direto_ok');
    expect(blobMp4Report.verdictLabel).toBe('direto ok');

    const htmlFakeMp4Report = await diagnoseVideoSource(
      {
        slot: 2,
        url: 'https://cdn.fake.example.com/episodio/01.mp4',
      },
      {
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response('<!doctype html><html><body>Access denied</body></html>', {
            status: 200,
            headers: {
              'content-type': 'text/html; charset=utf-8',
            },
          }),
        }),
      }
    );

    expect(htmlFakeMp4Report.detectedKind).toBe('mp4');
    expect(htmlFakeMp4Report.verdict).toBe('bloqueado');
    expect(htmlFakeMp4Report.verdictLabel).toBe('bloqueado');
  });

  it('15. no "Testar fonte", reprova espelho cujo tamanho seja menor que 90% do content-length original e aprova >= 90%', async () => {
    const originalSize = 200 * 1024 * 1024; // 200 MB
    const truncatedMirrorSize = 48 * 1024 * 1024; // 48 MB (< 90%)
    const validMirrorSize = 190 * 1024 * 1024; // 190 MB (>= 90%)

    // 15a. Comparação automática entre fonte original e espelho via diagnoseEpisodeSources
    const truncatedEpisodeReports = await diagnoseEpisodeSources(
      [
        {
          slot: 1,
          label: 'Player 1',
          url: 'https://cdn-sv01.maximaimg.online/files/ep01.mp4',
          kind: 'mp4',
        },
        {
          slot: 2,
          label: 'Player 2 (espelho)',
          url: 'https://q70piqtcusyiwtbz.public.blob.vercel-storage.com/mirrors/anime/ep01.mp4',
          kind: 'mp4',
          isMirror: true,
        },
      ],
      {
        fetchWithRedirects: async (url) => {
          if (url.includes('public.blob.vercel-storage.com')) {
            return {
              finalUrl: url,
              response: new Response(new Uint8Array([0, 0, 0, 24]), {
                status: 200,
                headers: {
                  'content-type': 'video/mp4',
                  'content-length': String(truncatedMirrorSize),
                },
              }),
            };
          }
          return {
            finalUrl: url,
            response: new Response(new Uint8Array([0, 0, 0, 24]), {
              status: 200,
              headers: {
                'content-type': 'video/mp4',
                'content-length': String(originalSize),
              },
            }),
          };
        },
      }
    );

    expect(truncatedEpisodeReports[1].verdict).toBe('bloqueado');
    expect(truncatedEpisodeReports[1].verdictLabel).toBe('bloqueado');
    expect(truncatedEpisodeReports[1].verdictReason).toContain('abaixo de 90%');

    // 15b. Espelho com >= 90% do tamanho original é aprovado como direto_ok
    const validMirrorReport = await diagnoseVideoSource(
      {
        slot: 2,
        url: 'https://q70piqtcusyiwtbz.public.blob.vercel-storage.com/mirrors/anime/ep01.mp4',
        isMirror: true,
        originalContentLength: originalSize,
      },
      {
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(new Uint8Array([0, 0, 0, 24]), {
            status: 200,
            headers: {
              'content-type': 'video/mp4',
              'content-length': String(validMirrorSize),
            },
          }),
        }),
      }
    );

    expect(validMirrorReport.verdict).toBe('direto_ok');
    expect(validMirrorReport.verdictLabel).toBe('direto ok');
  });

  it('16. resolve e reescreve todas as URIs (cross-host, protocolo relativo, KEY, MAP, MEDIA, I-FRAME, PREFETCH, URI sem aspas) preservando URL original para referer do host certo', async () => {
    const masterUrl = 'https://origin-a.example.com/hls/master.m3u8?v=1';
    const masterBody = [
      '#EXTM3U',
      '#EXT-X-SESSION-KEY:METHOD=AES-128,URI=//keys.othercdn.net/session.key',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g1",NAME="JP",URI="/audio/jp.m3u8?q=1"',
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=120000,URI=https://iframe-cdn.other.net/iframes.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000',
      'https://variant-b.cdn.example.net/stream/720p/index.m3u8?hd=1',
      '#EXT-X-KEY:METHOD=AES-128,URI=keys/enc.key',
      '#EXT-X-MAP:URI="https://map-c.cdn.example.net/init.mp4"',
      '#EXT-X-PREFETCH:https://prefetch-d.cdn.example.net/next.ts',
    ].join('\n');

    const signedMaster = buildSignedProxyPath(masterUrl);
    const res = await handleProxyStreamRequest(new Request(`http://localhost${signedMaster}`), {
      fetchWithRedirects: async (url) => ({
        finalUrl: url,
        response: new Response(masterBody, {
          status: 200,
          headers: { 'content-type': 'application/vnd.apple.mpegurl' },
        }),
      }),
    });

    expect(res.status).toBe(200);
    const rewritten = await res.text();

    const extractProxiedUrls = (text: string): URL[] => {
      const matches = text.match(/\/api\/proxy\/stream\?[^\s"']+/g) ?? [];
      return matches.map((m) => new URL(`http://localhost${m}`));
    };
    const proxiedUrls = extractProxiedUrls(rewritten);
    const targetUrls = proxiedUrls.map((u) => u.searchParams.get('url'));

    expect(targetUrls).toContain('https://keys.othercdn.net/session.key');
    expect(targetUrls).toContain('https://origin-a.example.com/audio/jp.m3u8?q=1');
    expect(targetUrls).toContain('https://iframe-cdn.other.net/iframes.m3u8');
    expect(targetUrls).toContain('https://variant-b.cdn.example.net/stream/720p/index.m3u8?hd=1');
    expect(targetUrls).toContain('https://origin-a.example.com/hls/keys/enc.key');
    expect(targetUrls).toContain('https://map-c.cdn.example.net/init.mp4');
    expect(targetUrls).toContain('https://prefetch-d.cdn.example.net/next.ts');

    // Cada host recebe o próprio Referer daquele host ao buscar via proxy
    const variantEntry = proxiedUrls.find(
      (u) => u.searchParams.get('url') === 'https://variant-b.cdn.example.net/stream/720p/index.m3u8?hd=1'
    )!;
    let capturedVariantReferer: string | undefined;
    const varRes = await handleProxyStreamRequest(new Request(variantEntry.toString()), {
      fetchWithRedirects: async (url, init) => {
        capturedVariantReferer = init?.headers?.['Referer'];
        return {
          finalUrl: url,
          response: new Response('#EXTM3U\n#EXTINF:5.0,\nseg01.ts\n#EXT-X-ENDLIST', {
            status: 200,
            headers: { 'content-type': 'application/vnd.apple.mpegurl' },
          }),
        };
      },
    });
    expect(varRes.status).toBe(200);
    expect(capturedVariantReferer).toBe('https://variant-b.cdn.example.net/');
  });

  it('17. aplica reescrita recursiva de playlists de variante com profundidade máxima de 2 e bloqueia nível > 2', async () => {
    expect(MAX_HLS_REWRITE_DEPTH).toBe(2);
    const masterUrl = 'https://host0.example.com/master.m3u8';
    const level1Url = 'https://host1.example.com/variant1.m3u8';
    const level2Url = 'https://host2.example.com/variant2.m3u8';
    const segUrl = 'https://host3.example.com/chunk.ts';
    const level3PlaylistUrl = 'https://host3.example.com/too-deep.m3u8';

    const mockOrigin = async (url: string) => {
      if (url === masterUrl) {
        return {
          finalUrl: url,
          response: new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n${level1Url}`, {
            status: 200,
            headers: { 'content-type': 'application/vnd.apple.mpegurl' },
          }),
        };
      }
      if (url === level1Url) {
        return {
          finalUrl: url,
          response: new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500\n${level2Url}`, {
            status: 200,
            headers: { 'content-type': 'application/vnd.apple.mpegurl' },
          }),
        };
      }
      if (url === level2Url) {
        return {
          finalUrl: url,
          response: new Response(
            `#EXTM3U\n#EXTINF:4.0,\n${segUrl}\n#EXT-X-STREAM-INF:BANDWIDTH=200\n${level3PlaylistUrl}`,
            {
              status: 200,
              headers: { 'content-type': 'application/vnd.apple.mpegurl' },
            }
          ),
        };
      }
      if (url === segUrl) {
        return {
          finalUrl: url,
          response: new Response(new Uint8Array([0x47, 0x40, 0x00, 0x10]), {
            status: 200,
            headers: { 'content-type': 'video/mp2t' },
          }),
        };
      }
      return {
        finalUrl: url,
        response: new Response('#EXTM3U\n#EXTINF:4.0,\nseg.ts', {
          status: 200,
          headers: { 'content-type': 'application/vnd.apple.mpegurl' },
        }),
      };
    };

    const getChildProxyUrl = (playlistText: string, target: string): string => {
      const lines = playlistText.split('\n');
      const found = lines.find((line) => line.includes(encodeURIComponent(target)));
      if (!found) throw new Error(`URL não encontrada no manifesto reescrito: ${target}`);
      return `http://localhost${found.trim()}`;
    };

    // Profundidade 0: master.m3u8
    const r0 = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(masterUrl)}`),
      { fetchWithRedirects: mockOrigin }
    );
    expect(r0.status).toBe(200);
    const body0 = await r0.text();

    // Profundidade 1: variant1.m3u8
    const r1Url = getChildProxyUrl(body0, level1Url);
    expect(new URL(r1Url).searchParams.get('d')).toBe('1');
    const r1 = await handleProxyStreamRequest(new Request(r1Url), {
      fetchWithRedirects: mockOrigin,
    });
    expect(r1.status).toBe(200);
    const body1 = await r1.text();

    // Profundidade 2: variant2.m3u8 (limite máximo = 2, ainda reescrito!)
    const r2Url = getChildProxyUrl(body1, level2Url);
    expect(new URL(r2Url).searchParams.get('d')).toBe('2');
    const r2 = await handleProxyStreamRequest(new Request(r2Url), {
      fetchWithRedirects: mockOrigin,
    });
    expect(r2.status).toBe(200);
    const body2 = await r2.text();

    // Segmento binário referenciado pela variante de profundidade 2 (d=3) passa normalmente!
    const segProxyUrl = getChildProxyUrl(body2, segUrl);
    expect(new URL(segProxyUrl).searchParams.get('d')).toBe('3');
    const rSeg = await handleProxyStreamRequest(new Request(segProxyUrl), {
      fetchWithRedirects: mockOrigin,
    });
    expect(rSeg.status).toBe(200);
    expect(Array.from(new Uint8Array(await rSeg.arrayBuffer()))).toEqual([0x47, 0x40, 0x00, 0x10]);

    // Playlist #EXTM3U em profundidade 3 (> max 2) é barrada
    const tooDeepProxyUrl = getChildProxyUrl(body2, level3PlaylistUrl);
    const r3 = await handleProxyStreamRequest(new Request(tooDeepProxyUrl), {
      fetchWithRedirects: mockOrigin,
    });
    expect(r3.status).toBe(502);
  });

  it('18. aceita qualquer host e extensão dentro de playlist liberada (sem allowlist prévia), mas bloqueia dsig adulterado e SSRF privado', async () => {
    const masterUrl = 'https://cdn-principal.example.com/master.m3u8';
    const oddSegUrl = 'https://cdn-terceiro-qualquer.org/stream/segmento.php?id=99';
    const extensionlessVarUrl = 'https://edge-dinamico.net/live/720p';

    const masterRes = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(masterUrl)}`),
      {
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(
            `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n${extensionlessVarUrl}\n#EXTINF:5.0,\n${oddSegUrl}`,
            { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } }
          ),
        }),
      }
    );
    expect(masterRes.status).toBe(200);
    const masterText = await masterRes.text();
    const lines = masterText.split('\n');
    const proxiedVarPath = lines.find((l) => l.includes(encodeURIComponent(extensionlessVarUrl)))!;
    const proxiedOddSegPath = lines.find((l) => l.includes(encodeURIComponent(oddSegUrl)))!;

    // Segmento .php oriundo de playlist liberada é aceito pelo proxy sem allowlist prévia
    const segBytes = new Uint8Array([0x47, 0x40, 0x00, 0x20]);
    const oddSegRes = await handleProxyStreamRequest(
      new Request(`http://localhost${proxiedOddSegPath}`),
      {
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(segBytes, {
            status: 200,
            headers: { 'content-type': 'video/mp2t' },
          }),
        }),
      }
    );
    expect(oddSegRes.status).toBe(200);

    // Variante sem extensão vinda de playlist (mesmo com octet-stream) é inspecionada como #EXTM3U e reescrita
    const varRes = await handleProxyStreamRequest(
      new Request(`http://localhost${proxiedVarPath}`),
      {
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response('#EXTM3U\n#EXTINF:4.0,\nhttps://chunk-cdn.biz/01.bin', {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          }),
        }),
      }
    );
    expect(varRes.status).toBe(200);
    const varBody = await varRes.text();
    expect(varBody).toContain(encodeURIComponent('https://chunk-cdn.biz/01.bin'));

    // Requisição direta (fora de playlist) para .php continua bloqueada com 403
    const directPhpRes = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(oddSegUrl)}`),
      { fetchWithRedirects: vi.fn() }
    );
    expect(directPhpRes.status).toBe(403);

    // Tentativa de forjar d=1 & dsig inválido -> 403
    const forgedUrl = new URL(`http://localhost${proxiedOddSegPath}`);
    forgedUrl.searchParams.set('dsig', 'assinatura-forjada');
    const forgedRes = await handleProxyStreamRequest(new Request(forgedUrl.toString()), {
      fetchWithRedirects: vi.fn(),
    });
    expect(forgedRes.status).toBe(403);

    // Destino privado dentro de playlist assinada continua bloqueado por SSRF (502)
    const ssrfInPlaylist = buildSignedProxyPath('http://10.0.0.1/seg.ts', 600, undefined, 1);
    const ssrfRes = await handleProxyStreamRequest(
      new Request(`http://localhost${ssrfInPlaylist}`)
    );
    expect(ssrfRes.status).toBe(502);
  });

  it('19. faz retry automático ao receber 403: referer mapeado -> referer do host -> sem Referer (e sem retries extras em 200)', async () => {
    // 19a. Host com Referer mapeado (maximaimg) retorna 403 no mapa, 403 no referer do host, 200 sem Referer
    const maximaSeg = 'https://cdn-sv01.maximaimg.online/stream/b/ep01/seg-001.ts';
    const seenReferers: Array<string | undefined> = [];
    const tsBytes = new Uint8Array([0x47, 0x40, 0x00, 0x99]);

    const resA = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(maximaSeg)}`),
      {
        fetchWithRedirects: async (url, opts) => {
          const ref = opts?.headers?.['Referer'];
          seenReferers.push(ref);
          if (ref !== undefined) {
            return { finalUrl: url, response: new Response('Forbidden', { status: 403 }) };
          }
          return {
            finalUrl: url,
            response: new Response(tsBytes, {
              status: 200,
              headers: { 'content-type': 'video/mp2t' },
            }),
          };
        },
      }
    );

    expect(resA.status).toBe(200);
    expect(seenReferers).toEqual([
      'https://www.anitube.biz/',
      'https://api.anivideo.net/',
      'https://cdn-sv01.maximaimg.online/',
      undefined,
    ]);

    // 19b. Host genérico começa com referer do host e cai para sem Referer após 403
    const genericSeg = 'https://cdn.outro.example.com/hls/seg-002.ts';
    const genericReferers: Array<string | undefined> = [];
    const resB = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(genericSeg)}`),
      {
        fetchWithRedirects: async (url, opts) => {
          const ref = opts?.headers?.['Referer'];
          genericReferers.push(ref);
          if (ref) {
            return { finalUrl: url, response: new Response('Forbidden', { status: 403 }) };
          }
          return {
            finalUrl: url,
            response: new Response(tsBytes, {
              status: 200,
              headers: { 'content-type': 'video/mp2t' },
            }),
          };
        },
      }
    );
    expect(resB.status).toBe(200);
    expect(genericReferers).toEqual(['https://cdn.outro.example.com/', undefined]);

    // 19c. Host já funcional respondendo 200 na primeira tentativa não faz retries extras
    let callCount = 0;
    const resOk = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(maximaSeg)}`),
      {
        fetchWithRedirects: async (url) => {
          callCount++;
          return {
            finalUrl: url,
            response: new Response(tsBytes, {
              status: 200,
              headers: { 'content-type': 'video/mp2t' },
            }),
          };
        },
      }
    );
    expect(resOk.status).toBe(200);
    expect(callCount).toBe(1);
  });

  it('20. identifica fontes HLS expiraveis (X-Amz-Expires, token=, sig=) na URL, manifesto e variante sem afetar fontes normais', async () => {
    const expirableAmzUrl =
      'https://cdn.example.com/video/master.m3u8?X-Amz-Algorithm=AWS4&X-Amz-Expires=3600&X-Amz-Signature=abc';
    const expirableTokenUrl = 'https://cdn.example.com/video/index.m3u8?token=xyz123';
    const expirableSigUrl = 'https://cdn.example.com/video/index.m3u8?sig=abc999';
    const cleanM3u8Url = 'https://cdn.example.com/video/index.m3u8';
    const cleanMp4Url = 'https://cdn.example.com/video/ep.mp4?token=123';

    expect(isExpirableHlsSourceUrl(expirableAmzUrl)).toBe(true);
    expect(isExpirableHlsSourceUrl(expirableTokenUrl)).toBe(true);
    expect(isExpirableHlsSourceUrl(expirableSigUrl)).toBe(true);
    expect(isExpirableHlsSourceUrl(cleanM3u8Url)).toBe(false);
    expect(isExpirableHlsSourceUrl(cleanMp4Url)).toBe(false);
    expect(normalizeVideoSource(expirableAmzUrl, 1)?.isExpirable).toBe(true);
    expect(normalizeVideoSource(cleanM3u8Url, 1)?.isExpirable).toBeUndefined();

    // Proxy sinaliza manifesto expirável e evita cache imutável em segmentos expiraveis
    const bodyWithSigSegment =
      '#EXTM3U\n#EXTINF:5.0,\nhttps://cdn.example.com/seg-1.ts?sig=secret99\n#EXT-X-ENDLIST';
    const proxyManifestRes = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(cleanM3u8Url)}`),
      {
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(bodyWithSigSegment, {
            status: 200,
            headers: { 'content-type': 'application/vnd.apple.mpegurl' },
          }),
        }),
      }
    );
    expect(proxyManifestRes.status).toBe(200);
    expect(proxyManifestRes.headers.get('x-hikari-source-expirable')).toBe('1');

    const expirableSegUrl = 'https://cdn.example.com/seg-1.ts?X-Amz-Expires=120&sig=abc';
    const proxySegRes = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(expirableSegUrl)}`),
      {
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(new Uint8Array([0x47, 0x40, 0x00, 0x10]), {
            status: 200,
            headers: { 'content-type': 'video/mp2t' },
          }),
        }),
      }
    );
    expect(proxySegRes.headers.get('cache-control')).not.toContain('immutable');

    // Diagnóstico identifica M3U8 com token= dentro da variante
    const diag = await diagnoseVideoSource(
      { slot: 1, url: cleanM3u8Url },
      {
        fetchWithRedirects: async (url) => {
          if (url === cleanM3u8Url) {
            return {
              finalUrl: url,
              response: new Response(
                '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nhttps://cdn.example.com/720p.m3u8',
                { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } }
              ),
            };
          }
          return {
            finalUrl: url,
            response: new Response(
              '#EXTM3U\n#EXTINF:6.0,\nseg01.ts?token=ephemeral-1\n#EXT-X-ENDLIST',
              { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } }
            ),
          };
        },
      }
    );
    expect(diag.isExpirable).toBe(true);
    expect(diag.expirableReason).toContain('token=');
  });

  it('21. casa referer por sufixo de domínio e qualquer subdomínio cdn-* com anitube.biz principal e antigos como fallback', () => {
    const cdnUrl = new URL('https://cdn-s02.novo-provedor.net/stream/01/index.m3u8');
    expect(resolveUpstreamReferer(cdnUrl)).toBe('https://www.anitube.biz/');
    expect(resolveUpstreamRefererCandidates(cdnUrl)).toEqual([
      'https://www.anitube.biz/',
      'https://api.anivideo.net/',
      'https://www.coempregos.com.br/',
      'https://cdn-s02.novo-provedor.net/',
      '',
    ]);

    const suffixMap = JSON.stringify({
      'provedor-novo.net': 'https://www.anitube.biz/',
      'cdn-*.custom.org': 'https://www.coempregos.com.br/',
    });
    expect(
      resolveUpstreamReferer(new URL('https://edge01.provedor-novo.net/ep1.m3u8'), suffixMap)
    ).toBe('https://www.anitube.biz/');
    expect(
      resolveUpstreamReferer(new URL('https://cdn-09.sub.custom.org/ep1.m3u8'), suffixMap)
    ).toBe('https://www.coempregos.com.br/');
  });

  it('22. propaga o Referer vencedor após fallback 403 para playlists aninhadas, segmentos, EXT-X-KEY e EXT-X-MAP (incluindo relativas pós-redirect e absolutas)', async () => {
    const masterUrl = 'https://cdn-s01.mywallpaper-4k-image.net/redirect/master.m3u8';
    const redirectedMasterUrl = 'https://edge02.mywallpaper-4k-image.net/hls/ep21/master.m3u8';
    const variantUrl = 'https://edge02.mywallpaper-4k-image.net/hls/ep21/720p/index.m3u8';
    const keyUrl = 'https://edge02.mywallpaper-4k-image.net/hls/ep21/720p/keys/enc.key';
    const mapUrl = 'https://edge02.mywallpaper-4k-image.net/hls/ep21/720p/init.mp4';
    const relSegUrl = 'https://edge02.mywallpaper-4k-image.net/hls/ep21/720p/seg-001.webp';
    const absSegUrl = 'https://cdn-backup.outrohost.net/chunks/seg-002.ts?tok=xyz';

    const seenReferersByUrl = new Map<string, Array<string | undefined>>();
    const mockFetchWithRedirects = async (url: string, opts?: { headers?: Record<string, string> }) => {
      const ref = opts?.headers?.['Referer'];
      const list = seenReferersByUrl.get(url) ?? [];
      list.push(ref);
      seenReferersByUrl.set(url, list);

      // Todos os recursos deste provedor exigem https://api.anivideo.net/ (fallback #2 após 403 em anitube.biz)
      if (ref !== 'https://api.anivideo.net/') {
        return {
          finalUrl: url,
          response: new Response('Forbidden', { status: 403 }),
        };
      }

      if (url === masterUrl) {
        return {
          finalUrl: redirectedMasterUrl,
          response: new Response(
            [
              '#EXTM3U',
              '#EXT-X-STREAM-INF:BANDWIDTH=2000000',
              '720p/index.m3u8',
            ].join('\n'),
            {
              status: 200,
              headers: { 'content-type': 'application/vnd.apple.mpegurl' },
            }
          ),
        };
      }

      if (url === variantUrl) {
        return {
          finalUrl: variantUrl,
          response: new Response(
            [
              '#EXTM3U',
              '#EXT-X-VERSION:7',
              '#EXT-X-KEY:METHOD=AES-128,URI="keys/enc.key"',
              '#EXT-X-MAP:URI="init.mp4"',
              '#EXTINF:6.0,',
              'seg-001.webp',
              '#EXTINF:6.0,',
              absSegUrl,
              '#EXT-X-ENDLIST',
            ].join('\n'),
            {
              status: 200,
              headers: { 'content-type': 'application/vnd.apple.mpegurl' },
            }
          ),
        };
      }

      if (url === keyUrl || url === mapUrl) {
        return {
          finalUrl: url,
          response: new Response(new Uint8Array([0x00, 0x01, 0x02, 0x03]), {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          }),
        };
      }

      return {
        finalUrl: url,
        response: new Response(new Uint8Array([0x47, 0x40, 0x00, 0x10]), {
          status: 200,
          headers: { 'content-type': 'image/webp' },
        }),
      };
    };

    const masterRes = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(masterUrl)}`),
      { fetchWithRedirects: mockFetchWithRedirects }
    );
    expect(masterRes.status).toBe(200);
    // Master tentou padrão (anitube.biz -> 403) e venceu com fallback (api.anivideo.net -> 200)
    expect(seenReferersByUrl.get(masterUrl)).toEqual([
      'https://www.anitube.biz/',
      'https://api.anivideo.net/',
    ]);

    const masterText = await masterRes.text();
    const variantPath = masterText.split('\n').find((l) => l.includes(encodeURIComponent(variantUrl)))!.trim();
    const variantParsed = new URL(`http://localhost${variantPath}`);
    expect(variantParsed.searchParams.get('ref')).toBe('https://api.anivideo.net/');
    expect(variantParsed.searchParams.get('rsig')).toBeTruthy();

    // Variante já recebe o Referer vencedor na 1ª tentativa (sem 403 prévio) e propaga aos filhos
    const variantRes = await handleProxyStreamRequest(new Request(variantParsed.toString()), {
      fetchWithRedirects: mockFetchWithRedirects,
    });
    expect(variantRes.status).toBe(200);
    expect(seenReferersByUrl.get(variantUrl)).toEqual(['https://api.anivideo.net/']);

    const variantText = await variantRes.text();
    const proxiedUrls = (variantText.match(/\/api\/proxy\/stream\?[^\s"']+/g) ?? []).map(
      (p) => new URL(`http://localhost${p}`)
    );

    const findChild = (target: string) =>
      proxiedUrls.find((u) => u.searchParams.get('url') === target);

    for (const target of [keyUrl, mapUrl, relSegUrl, absSegUrl]) {
      const childUrl = findChild(target);
      expect(childUrl, `URL filha ausente: ${target}`).toBeDefined();
      expect(childUrl!.searchParams.get('ref')).toBe('https://api.anivideo.net/');
      expect(childUrl!.searchParams.get('rsig')).toBeTruthy();

      const childRes = await handleProxyStreamRequest(new Request(childUrl!.toString()), {
        fetchWithRedirects: mockFetchWithRedirects,
      });
      expect(childRes.status).toBe(200);
      expect(seenReferersByUrl.get(target)).toEqual(['https://api.anivideo.net/']);
    }
  });

  it('23. mantém comportamento padrão sem ref/rsig quando nenhum fallback é necessário e quando o fallback vencedor é sem Referer', async () => {
    // 23a. Playlist carregada de primeira com Referer padrão -> filhos não recebem ref/rsig extras
    const defaultMasterUrl = 'https://cdn-sv01.maximaimg.online/stream/b/bakemonogatari/01.mp4/index.m3u8';
    const defaultRes = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(defaultMasterUrl)}`),
      {
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response('#EXTM3U\n#EXTINF:6.0,\nseg-001.ts\n#EXT-X-ENDLIST', {
            status: 200,
            headers: { 'content-type': 'application/vnd.apple.mpegurl' },
          }),
        }),
      }
    );
    expect(defaultRes.status).toBe(200);
    const defaultBody = await defaultRes.text();
    const defaultChildPath = defaultBody.split('\n').find((l) => l.includes('seg-001.ts'))!.trim();
    const defaultChildUrl = new URL(`http://localhost${defaultChildPath}`);
    expect(defaultChildUrl.searchParams.has('ref')).toBe(false);
    expect(defaultChildUrl.searchParams.has('rsig')).toBe(false);

    // 23b. Playlist que vence apenas sem Referer ('') após 403 não falha nem emite ref inválido
    const noRefMasterUrl = 'https://cdn.semreferer.example.com/hls/master.m3u8';
    const noRefRes = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(noRefMasterUrl)}`),
      {
        fetchWithRedirects: async (url, opts) => {
          if (opts?.headers?.['Referer']) {
            return { finalUrl: url, response: new Response('Forbidden', { status: 403 }) };
          }
          return {
            finalUrl: url,
            response: new Response('#EXTM3U\n#EXTINF:6.0,\nseg-001.ts\n#EXT-X-ENDLIST', {
              status: 200,
              headers: { 'content-type': 'application/vnd.apple.mpegurl' },
            }),
          };
        },
      }
    );
    expect(noRefRes.status).toBe(200);
    const noRefBody = await noRefRes.text();
    const noRefChildPath = noRefBody.split('\n').find((l) => l.includes('seg-001.ts'))!.trim();
    const noRefChildUrl = new URL(`http://localhost${noRefChildPath}`);
    expect(noRefChildUrl.searchParams.has('ref')).toBe(false);
    expect(noRefChildUrl.searchParams.has('rsig')).toBe(false);
  });

  it('24. rejeita no proxy (HTTP 403 sem chamada upstream) parâmetro ref arbitrário, adulterado ou sem rsig válida', async () => {
    const target = 'https://cdn-s01.mywallpaper-4k-image.net/stream/ep21/seg-001.webp';
    const signedWithRef = buildSignedProxyPath(target, undefined, undefined, 1, 'https://api.anivideo.net/');
    const validUrl = new URL(`http://localhost${signedWithRef}`);
    const upstreamMock = vi.fn();

    // Sem rsig
    const missingRsig = new URL(validUrl.toString());
    missingRsig.searchParams.delete('rsig');
    const r1 = await handleProxyStreamRequest(new Request(missingRsig.toString()), {
      fetchWithRedirects: upstreamMock,
    });
    expect(r1.status).toBe(403);

    // ref adulterado mantendo rsig antiga
    const tamperedRef = new URL(validUrl.toString());
    tamperedRef.searchParams.set('ref', 'https://attacker.example.com/');
    const r2 = await handleProxyStreamRequest(new Request(tamperedRef.toString()), {
      fetchWithRedirects: upstreamMock,
    });
    expect(r2.status).toBe(403);

    // ref arbitrário adicionado a URL assinada sem ref
    const baseSigned = new URL(`http://localhost${buildSignedProxyPath(target)}`);
    baseSigned.searchParams.set('ref', 'https://arbitrary.example.com/');
    baseSigned.searchParams.set(
      'rsig',
      createProxyRefererSignature('https://other.example.com/x.ts', Number(baseSigned.searchParams.get('exp')), 'https://arbitrary.example.com/')
    );
    const r3 = await handleProxyStreamRequest(new Request(baseSigned.toString()), {
      fetchWithRedirects: upstreamMock,
    });
    expect(r3.status).toBe(403);

    expect(upstreamMock).not.toHaveBeenCalled();
  });

  it('25. inclui coempregos.com.br no fallback do Mywallpaper, amplia fallbacks de provedores mapeados e preserva ordem exata do Maximaimg', async () => {
    // Mywallpaper: tenta anitube.biz -> api.anivideo.net -> coempregos.com.br
    const mywUrl = new URL('https://cdn-s01.mywallpaper-4k-image.net/stream/ep01/index.m3u8');
    expect(resolveUpstreamRefererCandidates(mywUrl)).toEqual([
      'https://www.anitube.biz/',
      'https://api.anivideo.net/',
      'https://www.coempregos.com.br/',
      '',
      'https://cdn-s01.mywallpaper-4k-image.net/',
    ]);

    const mywStream = 'https://cdn-s01.mywallpaper-4k-image.net/stream/ep01/seg-001.webp';
    const seenMywRefs: Array<string | undefined> = [];
    const resMyw = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(mywStream)}`),
      {
        fetchWithRedirects: async (url, opts) => {
          const ref = opts?.headers?.['Referer'];
          seenMywRefs.push(ref);
          if (ref === 'https://www.coempregos.com.br/') {
            return {
              finalUrl: url,
              response: new Response(new Uint8Array([0x47, 0x40, 0x00, 0x11]), {
                status: 200,
                headers: { 'content-type': 'image/webp' },
              }),
            };
          }
          return { finalUrl: url, response: new Response('Forbidden', { status: 403 }) };
        },
      }
    );
    expect(resMyw.status).toBe(200);
    expect(seenMywRefs).toEqual([
      'https://www.anitube.biz/',
      'https://api.anivideo.net/',
      'https://www.coempregos.com.br/',
    ]);

    // Provedor configurado em regra ganha fallback completo seguro após o primário
    const hinataUrl = new URL('https://hinatasoul.com/videos/ep01.m3u8');
    expect(resolveUpstreamRefererCandidates(hinataUrl)).toEqual([
      'https://www.coempregos.com.br/',
      'https://www.anitube.biz/',
      'https://api.anivideo.net/',
      'https://hinatasoul.com/',
      '',
    ]);

    // Maximaimg mantém exatamente a mesma ordem e não altera ordem mesmo se learnedReferer for passado
    const maximaUrl = new URL('https://cdn-sv01.maximaimg.online/stream/b/bakemonogatari/01.mp4/index.m3u8');
    expect(
      resolveUpstreamRefererCandidates(maximaUrl, undefined, undefined, undefined, 'https://www.coempregos.com.br/')
    ).toEqual([
      'https://www.anitube.biz/',
      'https://api.anivideo.net/',
      'https://cdn-sv01.maximaimg.online/',
      '',
    ]);
  });

  it('26. aprende e reutiliza temporariamente Referer vencedor por host evitando 403 repetido e mantendo propagação ref/rsig', async () => {
    const seg1 = 'https://cdn-s02.mywallpaper-4k-image.net/stream/ep01/seg-001.webp';
    const playlist2 = 'https://cdn-s02.mywallpaper-4k-image.net/stream/ep02/master.m3u8';
    const childOnOtherHost = 'https://edge99.othercdn.example.net/ep02/seg-001.ts';

    const seenByUrl = new Map<string, Array<string | undefined>>();
    const mockFetch = async (url: string, opts?: { headers?: Record<string, string> }) => {
      const ref = opts?.headers?.['Referer'];
      const arr = seenByUrl.get(url) ?? [];
      arr.push(ref);
      seenByUrl.set(url, arr);

      if (ref !== 'https://www.coempregos.com.br/') {
        return { finalUrl: url, response: new Response('Forbidden', { status: 403 }) };
      }
      if (url === playlist2) {
        return {
          finalUrl: url,
          response: new Response(`#EXTM3U\n#EXTINF:5.0,\n${childOnOtherHost}\n#EXT-X-ENDLIST`, {
            status: 200,
            headers: { 'content-type': 'application/vnd.apple.mpegurl' },
          }),
        };
      }
      return {
        finalUrl: url,
        response: new Response(new Uint8Array([0x47, 0x40, 0x00, 0x22]), {
          status: 200,
          headers: { 'content-type': 'image/webp' },
        }),
      };
    };

    // 1ª requisição descobre que coempregos funciona após fallback 403
    const r1 = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(seg1)}`),
      { fetchWithRedirects: mockFetch }
    );
    expect(r1.status).toBe(200);
    expect(seenByUrl.get(seg1)).toEqual([
      'https://www.anitube.biz/',
      'https://api.anivideo.net/',
      'https://www.coempregos.com.br/',
    ]);

    // 2ª requisição no mesmo host reutiliza coempregos logo na 1ª tentativa (zero 403) e propaga ref/rsig aos filhos
    const r2 = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(playlist2)}`),
      { fetchWithRedirects: mockFetch }
    );
    expect(r2.status).toBe(200);
    expect(seenByUrl.get(playlist2)).toEqual(['https://www.coempregos.com.br/']);

    const playlist2Body = await r2.text();
    const childPath = playlist2Body.split('\n').find((l) => l.includes(encodeURIComponent(childOnOtherHost)))!.trim();
    const childUrl = new URL(`http://localhost${childPath}`);
    expect(childUrl.searchParams.get('ref')).toBe('https://www.coempregos.com.br/');
    expect(childUrl.searchParams.get('rsig')).toBeTruthy();
  });

  it('27. isola Referer aprendido entre hosts diferentes e entre Preview vs Production e expira após TTL de 15 min', async () => {
    expect(LEARNED_REFERER_TTL_SECONDS).toBe(15 * 60);
    let currentNowMs = 1_795_000_000_000;
    const origVercelEnv = process.env.VERCEL_ENV;
    const origVercelUrl = process.env.VERCEL_URL;

    try {
      process.env.VERCEL_ENV = 'preview';
      process.env.VERCEL_URL = 'hikari-git-etapa2.vercel.app';

      const hostAUrl = 'https://cdn-a.mywallpaper-4k-image.net/stream/ep1/seg-1.webp';
      const hostBUrl = 'https://cdn-b.mywallpaper-4k-image.net/stream/ep1/seg-1.webp';

      const seenHostA: Array<string | undefined> = [];
      const seenHostB: Array<string | undefined> = [];

      // Host A aprende api.anivideo.net no ambiente Preview
      await handleProxyStreamRequest(
        new Request(`http://localhost${buildSignedProxyPath(hostAUrl)}`),
        {
          nowMs: () => currentNowMs,
          fetchWithRedirects: async (url, opts) => {
            const ref = opts?.headers?.['Referer'];
            seenHostA.push(ref);
            if (ref === 'https://api.anivideo.net/') {
              return {
                finalUrl: url,
                response: new Response(new Uint8Array([0x47, 0x40, 0x00, 0x01]), {
                  status: 200,
                  headers: { 'content-type': 'image/webp' },
                }),
              };
            }
            return { finalUrl: url, response: new Response('Forbidden', { status: 403 }) };
          },
        }
      );
      expect(seenHostA).toEqual(['https://www.anitube.biz/', 'https://api.anivideo.net/']);

      // Host B NÃO reaproveita Referer aprendido do Host A (tenta padrão primeiro)
      await handleProxyStreamRequest(
        new Request(`http://localhost${buildSignedProxyPath(hostBUrl)}`),
        {
          nowMs: () => currentNowMs,
          fetchWithRedirects: async (url, opts) => {
            seenHostB.push(opts?.headers?.['Referer']);
            return {
              finalUrl: url,
              response: new Response(new Uint8Array([0x47, 0x40, 0x00, 0x02]), {
                status: 200,
                headers: { 'content-type': 'image/webp' },
              }),
            };
          },
        }
      );
      expect(seenHostB).toEqual(['https://www.anitube.biz/']);

      // Mudando para Production, o aprendizado feito em Preview NÃO vaza para o Host A em Production
      process.env.VERCEL_ENV = 'production';
      delete process.env.VERCEL_URL;
      const seenProdHostA: Array<string | undefined> = [];
      await handleProxyStreamRequest(
        new Request(`http://localhost${buildSignedProxyPath(hostAUrl)}`),
        {
          nowMs: () => currentNowMs,
          fetchWithRedirects: async (url, opts) => {
            seenProdHostA.push(opts?.headers?.['Referer']);
            return {
              finalUrl: url,
              response: new Response(new Uint8Array([0x47, 0x40, 0x00, 0x03]), {
                status: 200,
                headers: { 'content-type': 'image/webp' },
              }),
            };
          },
        }
      );
      expect(seenProdHostA).toEqual(['https://www.anitube.biz/']);

      // Voltando para Preview antes do TTL: ainda usa api.anivideo.net
      process.env.VERCEL_ENV = 'preview';
      process.env.VERCEL_URL = 'hikari-git-etapa2.vercel.app';
      const seenPreviewBeforeExpiry: Array<string | undefined> = [];
      await handleProxyStreamRequest(
        new Request(`http://localhost${buildSignedProxyPath(hostAUrl)}`),
        {
          nowMs: () => currentNowMs + 60_000,
          fetchWithRedirects: async (url, opts) => {
            seenPreviewBeforeExpiry.push(opts?.headers?.['Referer']);
            return {
              finalUrl: url,
              response: new Response(new Uint8Array([0x47, 0x40, 0x00, 0x04]), {
                status: 200,
                headers: { 'content-type': 'image/webp' },
              }),
            };
          },
        }
      );
      expect(seenPreviewBeforeExpiry).toEqual(['https://api.anivideo.net/']);

      // Após expirar TTL (15 min + 1s): volta à ordem padrão normal
      currentNowMs += LEARNED_REFERER_TTL_SECONDS * 1000 + 1000;
      const seenPreviewAfterExpiry: Array<string | undefined> = [];
      await handleProxyStreamRequest(
        new Request(`http://localhost${buildSignedProxyPath(hostAUrl)}`),
        {
          nowMs: () => currentNowMs,
          fetchWithRedirects: async (url, opts) => {
            seenPreviewAfterExpiry.push(opts?.headers?.['Referer']);
            return {
              finalUrl: url,
              response: new Response(new Uint8Array([0x47, 0x40, 0x00, 0x05]), {
                status: 200,
                headers: { 'content-type': 'image/webp' },
              }),
            };
          },
        }
      );
      expect(seenPreviewAfterExpiry).toEqual(['https://www.anitube.biz/']);
    } finally {
      if (origVercelEnv === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = origVercelEnv;
      if (origVercelUrl === undefined) delete process.env.VERCEL_URL;
      else process.env.VERCEL_URL = origVercelUrl;
    }
  });

  it('28. opera fail-open se store de Referer falhar e invalida Referer aprendido quando passa a retornar 403', async () => {
    const targetUrl = 'https://cdn-s05.mywallpaper-4k-image.net/stream/ep1/seg-001.webp';

    // 28a. Store com falha em get/set/delete nunca interrompe a reprodução
    const brokenStore: LearnedRefererStore = {
      async get() {
        throw new Error('storage read failed');
      },
      async set() {
        throw new Error('storage write failed');
      },
      async delete() {
        throw new Error('storage delete failed');
      },
    };

    const resFailOpen = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(targetUrl)}`),
      {
        learnedRefererStore: brokenStore,
        fetchWithRedirects: async (url, opts) => {
          if (opts?.headers?.['Referer'] === 'https://api.anivideo.net/') {
            return {
              finalUrl: url,
              response: new Response(new Uint8Array([0x47, 0x40, 0x00, 0x08]), {
                status: 200,
                headers: { 'content-type': 'image/webp' },
              }),
            };
          }
          return { finalUrl: url, response: new Response('Forbidden', { status: 403 }) };
        },
      }
    );
    expect(resFailOpen.status).toBe(200);

    // 28b. Se Referer aprendido passa a devolver 403 e o padrão volta a funcionar, cache é invalidado
    let allowLearned = true;
    const seenRound2: Array<string | undefined> = [];
    const seenRound3: Array<string | undefined> = [];

    // Round 1: aprende api.anivideo.net
    const r1 = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(targetUrl)}`),
      {
        fetchWithRedirects: async (url, opts) => {
          if (opts?.headers?.['Referer'] === 'https://api.anivideo.net/') {
            return {
              finalUrl: url,
              response: new Response(new Uint8Array([0x47, 0x40, 0x00, 0x09]), {
                status: 200,
                headers: { 'content-type': 'image/webp' },
              }),
            };
          }
          return { finalUrl: url, response: new Response('Forbidden', { status: 403 }) };
        },
      }
    );
    expect(r1.status).toBe(200);

    // Round 2: api.anivideo.net falha com 403 e anitube.biz (padrão) volta a responder 200
    allowLearned = false;
    const r2 = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(targetUrl)}`),
      {
        fetchWithRedirects: async (url, opts) => {
          const ref = opts?.headers?.['Referer'];
          seenRound2.push(ref);
          if (!allowLearned && ref === 'https://www.anitube.biz/') {
            return {
              finalUrl: url,
              response: new Response(new Uint8Array([0x47, 0x40, 0x00, 0x0a]), {
                status: 200,
                headers: { 'content-type': 'image/webp' },
              }),
            };
          }
          return { finalUrl: url, response: new Response('Forbidden', { status: 403 }) };
        },
      }
    );
    expect(r2.status).toBe(200);
    expect(seenRound2).toEqual(['https://api.anivideo.net/', 'https://www.anitube.biz/']);

    // Round 3: cache foi limpo, portanto volta a tentar anitube.biz diretamente em 1 tentativa
    const r3 = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(targetUrl)}`),
      {
        fetchWithRedirects: async (url, opts) => {
          seenRound3.push(opts?.headers?.['Referer']);
          return {
            finalUrl: url,
            response: new Response(new Uint8Array([0x47, 0x40, 0x00, 0x0b]), {
              status: 200,
              headers: { 'content-type': 'image/webp' },
            }),
          };
        },
      }
    );
    expect(r3.status).toBe(200);
    expect(seenRound3).toEqual(['https://www.anitube.biz/']);
  });

  it('29. amplia detecção de tokens expiráveis (query, CloudFront, AWS, Akamai, caminho e case-insensitive) sem falsos positivos', () => {
    // 29a. Query params curtos/explícitos e assinaturas variadas
    expect(hasExpirableHlsTokens('https://cdn.example.com/hls/master.m3u8?expires=1795003600')).toBe(true);
    expect(hasExpirableHlsTokens('https://cdn.example.com/hls/master.m3u8?exp=1795003600')).toBe(true);
    expect(hasExpirableHlsTokens('https://cdn.example.com/hls/master.m3u8?e=1795003600&h=abc')).toBe(true);
    expect(hasExpirableHlsTokens('https://cdn.example.com/hls/master.m3u8?t=1795003600&sig=xyz')).toBe(true);
    expect(hasExpirableHlsTokens('https://cdn.example.com/hls/master.m3u8?token=abc123')).toBe(true);
    expect(hasExpirableHlsTokens('https://cdn.example.com/hls/master.m3u8?sig=abc123')).toBe(true);
    expect(hasExpirableHlsTokens('https://cdn.example.com/hls/master.m3u8?signature=abc123')).toBe(true);
    expect(hasExpirableHlsTokens('https://cdn.example.com/hls/master.m3u8?hash=deadbeef')).toBe(true);
    expect(hasExpirableHlsTokens('https://cdn.example.com/hls/master.m3u8?auth=secret')).toBe(true);
    expect(hasExpirableHlsTokens('https://cdn.example.com/hls/master.m3u8?hmac=feedface')).toBe(true);

    // 29b. Akamai hdnea, AWS, CloudFront, Google Cloud e variações de maiúsculas/minúsculas
    expect(
      hasExpirableHlsTokens('https://cdn.example.com/hls/master.m3u8?hdnea=st=1795000000~exp=1795003600~acl=/*~hmac=abcd')
    ).toBe(true);
    expect(
      hasExpirableHlsTokens(
        'https://bucket.s3.amazonaws.com/ep01/index.m3u8?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20261126T000000Z&X-Amz-Expires=900&X-Amz-Signature=abcdef'
      )
    ).toBe(true);
    expect(
      hasExpirableHlsTokens(
        'https://d111111abcdef8.cloudfront.net/ep01/index.m3u8?Policy=eyJT&Signature=abc~def&Key-Pair-Id=K123'
      )
    ).toBe(true);
    expect(
      hasExpirableHlsTokens('https://cdn.example.com/hls/master.m3u8?TOKEN=UPPER&EXPIRES=1795003600&x-amz-signature=low')
    ).toBe(true);

    // 29c. Assinaturas no caminho (path-based)
    expect(hasExpirableHlsTokens('https://cdn.example.com/token/a1b2c3d4e5f6/hls/master.m3u8')).toBe(true);
    expect(hasExpirableHlsTokens('https://cdn.example.com/sig/mysecret99/seg-01.ts')).toBe(true);
    expect(hasExpirableHlsTokens('https://cdn.example.com/expires/1795003600/index.m3u8')).toBe(true);
    expect(hasExpirableHlsTokens('https://cdn.example.com/0123456789abcdef012345/1795003600/index.m3u8')).toBe(true);
    expect(
      hasExpirableHlsTokens('https://cdn.example.com/hdnea=exp=1795003600~hmac=deadbeef/master.m3u8')
    ).toBe(true);
    expect(
      hasExpirableHlsTokens(
        'https://cdn.example.com/eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3OTUwMDM2MDB9.signaturePart123/master.m3u8'
      )
    ).toBe(true);

    // 29d. ZERO falsos positivos em URLs públicas comuns, fragmentos #t=, caminhos /t/ ou /auth/index.m3u8
    expect(hasExpirableHlsTokens('https://cdn.example.com/hls/index.m3u8?v=1&id=99&key=abc&lang=pt')).toBe(false);
    expect(hasExpirableHlsTokens('https://cdn.example.com/hls/index.m3u8#t=30')).toBe(false);
    expect(
      hasExpirableHlsTokens(
        'https://cdn-s01.mywallpaper-4k-image.net/stream/sv/t/tsuihou-sareta-tensei-juu-kishi-wa-game-chishiki-de-musou-suru/21v2.mp4/index.m3u8'
      )
    ).toBe(false);
    expect(hasExpirableHlsTokens('https://cdn.example.com/auth/index.m3u8')).toBe(false);
    expect(hasExpirableHlsTokens('https://cdn.example.com/token/index.m3u8')).toBe(false);
    expect(hasExpirableHlsTokens('https://cdn-sv01.maximaimg.online/stream/b/bakemonogatari/02.mp4/index.m3u8')).toBe(
      false
    );

    // 29e. Descrição e extração precisa de TTL restante
    expect(describeExpirableHlsTokens('https://cdn.example.com/index.m3u8?Expires=1795003600&Token=abc')).toEqual([
      'expires=',
      'token=',
    ]);
    const now = 1_795_000_000;
    expect(
      extractExpirableTokenRemainingSeconds('https://cdn.example.com/seg.ts?expires=1795000120', now)
    ).toBe(120);
    expect(
      extractExpirableTokenRemainingSeconds(
        'https://cdn.example.com/seg.ts?hdnea=st=1794999000~exp=1795000045~hmac=abc',
        now
      )
    ).toBe(45);
    expect(
      extractExpirableTokenRemainingSeconds(
        'https://s3.amazonaws.com/seg.ts?X-Amz-Date=20261125T000000Z&X-Amz-Expires=600&X-Amz-Signature=abc',
        Math.floor(Date.UTC(2026, 10, 25, 0, 5, 0) / 1000)
      )
    ).toBe(300);
    expect(extractExpirableTokenRemainingSeconds('https://cdn.example.com/seg.ts?token=opaco', now)).toBeNull();
  });

  it('30. mantém cache eficiente para URLs públicas e aplica no-store + propagação ex/xsig assinada em manifestos expiraveis', async () => {
    // 30a. Manifesto público sem tokens mantém Cache-Control público e filhos sem ex/xsig
    const publicMaster = 'https://cdn-sv01.maximaimg.online/stream/b/bakemonogatari/02.mp4/index.m3u8?v=1';
    const publicRes = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(publicMaster)}`),
      {
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response('#EXTM3U\n#EXTINF:5.0,\nseg-001.ts\n#EXT-X-ENDLIST', {
            status: 200,
            headers: { 'content-type': 'application/vnd.apple.mpegurl' },
          }),
        }),
      }
    );
    expect(publicRes.status).toBe(200);
    expect(publicRes.headers.get('cache-control')).toBe('public, max-age=5, stale-while-revalidate=30');
    expect(publicRes.headers.get('cdn-cache-control')).toBe('public, max-age=5, stale-while-revalidate=30');
    expect(publicRes.headers.get('x-hikari-source-expirable')).toBeNull();
    const publicBody = await publicRes.text();
    const publicChildUrl = new URL(
      `http://localhost${publicBody.split('\n').find((l) => l.includes('seg-001.ts'))!.trim()}`
    );
    expect(publicChildUrl.searchParams.has('ex')).toBe(false);
    expect(publicChildUrl.searchParams.has('xsig')).toBe(false);

    // 30b. Manifesto expirável retorna no-store e propaga ex=1&xsig para variante, KEY, MAP e segmentos
    const signedMaster = 'https://cdn.signed.example.com/ep01/master.m3u8?token=abc123&expires=1999999999';
    const signedRes = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(signedMaster)}`),
      {
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(
            [
              '#EXTM3U',
              '#EXT-X-KEY:METHOD=AES-128,URI="keys/enc.key"',
              '#EXT-X-MAP:URI="init.mp4"',
              '#EXT-X-STREAM-INF:BANDWIDTH=1000000',
              '720p/index.m3u8',
              '#EXTINF:5.0,',
              'seg-001.ts',
            ].join('\n'),
            {
              status: 200,
              headers: { 'content-type': 'application/vnd.apple.mpegurl' },
            }
          ),
        }),
      }
    );
    expect(signedRes.status).toBe(200);
    expect(signedRes.headers.get('cache-control')).toBe('no-store');
    expect(signedRes.headers.get('cdn-cache-control')).toBe('no-store');
    expect(signedRes.headers.get('x-hikari-source-expirable')).toBe('1');

    const signedBody = await signedRes.text();
    const childUrls = (signedBody.match(/\/api\/proxy\/stream\?[^\s"']+/g) ?? []).map(
      (p) => new URL(`http://localhost${p}`)
    );
    expect(childUrls).toHaveLength(4);
    for (const childUrl of childUrls) {
      expect(childUrl.searchParams.get('ex')).toBe('1');
      expect(childUrl.searchParams.get('xsig')).toBeTruthy();
    }

    // 30c. ex/xsig adulterado é rejeitado com 403 antes de chamar upstream
    const forgedFetcher = vi.fn();
    const forgedChild = new URL(childUrls[0].toString());
    forgedChild.searchParams.set('xsig', 'xsig-forjada');
    const forgedRes = await handleProxyStreamRequest(new Request(forgedChild.toString()), {
      fetchWithRedirects: forgedFetcher,
    });
    expect(forgedRes.status).toBe(403);
    expect(forgedFetcher).not.toHaveBeenCalled();

    const missingXsig = new URL(childUrls[0].toString());
    missingXsig.searchParams.delete('xsig');
    const missingXsigRes = await handleProxyStreamRequest(new Request(missingXsig.toString()), {
      fetchWithRedirects: forgedFetcher,
    });
    expect(missingXsigRes.status).toBe(403);

    const forgedExPayload = new URL(
      `http://localhost${buildSignedProxyPath('https://cdn.signed.example.com/ep01/seg-001.ts', undefined, undefined, 1)}`
    );
    forgedExPayload.searchParams.set('ex', '1');
    forgedExPayload.searchParams.set(
      'xsig',
      createProxyExpirableSignature(
        'https://other.example.com/other.ts',
        Number(forgedExPayload.searchParams.get('exp'))
      )
    );
    const wrongTargetExRes = await handleProxyStreamRequest(
      new Request(forgedExPayload.toString()),
      { fetchWithRedirects: forgedFetcher }
    );
    expect(wrongTargetExRes.status).toBe(403);
    expect(forgedFetcher).not.toHaveBeenCalled();
  });

  it('31. aplica política segura de cache em segmentos/recursos derivados (TTL calculável, fallback no-store e respeito ao Cache-Control da origem)', async () => {
    const now = 1_795_000_000;
    const tsBytes = new Uint8Array([0x47, 0x40, 0x00, 0x10]);

    // 31a. Segmento derivado com ex=1 sem TTL determinável -> no-store
    const inheritedSegPath = buildSignedProxyPath(
      'https://cdn.signed.example.com/ep01/seg-001.ts',
      undefined,
      undefined,
      1,
      null,
      true
    );
    const opaqueRes = await handleProxyStreamRequest(new Request(`http://localhost${inheritedSegPath}`), {
      nowSeconds: () => now,
      fetchWithRedirects: async (url) => ({
        finalUrl: url,
        response: new Response(tsBytes, {
          status: 200,
          headers: { 'content-type': 'video/mp2t' },
        }),
      }),
    });
    expect(opaqueRes.status).toBe(200);
    expect(opaqueRes.headers.get('cache-control')).toBe('no-store');
    expect(opaqueRes.headers.get('cdn-cache-control')).toBe('no-store');
    expect(opaqueRes.headers.get('x-hikari-source-expirable')).toBe('1');

    // 31b. Segmento com TTL futuro longo (expires=now+120) -> limitado a private, max-age=30, must-revalidate + CDN no-store
    const longTtlSeg = `https://cdn.signed.example.com/ep01/seg-002.ts?token=abc&expires=${now + 120}`;
    const longTtlRes = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(longTtlSeg)}`),
      {
        nowSeconds: () => now,
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(tsBytes, {
            status: 200,
            headers: { 'content-type': 'video/mp2t' },
          }),
        }),
      }
    );
    expect(longTtlRes.headers.get('cache-control')).toBe('private, max-age=30, must-revalidate');
    expect(longTtlRes.headers.get('cdn-cache-control')).toBe('no-store');
    expect(longTtlRes.headers.get('x-hikari-source-expirable')).toBe('1');

    // 31c. Segmento com TTL curto (expires=now+15) -> desconta margem 5s -> max-age=10
    const shortTtlSeg = `https://cdn.signed.example.com/ep01/seg-003.ts?token=abc&expires=${now + 15}`;
    const shortTtlRes = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(shortTtlSeg)}`),
      {
        nowSeconds: () => now,
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(tsBytes, {
            status: 200,
            headers: { 'content-type': 'video/mp2t' },
          }),
        }),
      }
    );
    expect(shortTtlRes.headers.get('cache-control')).toBe('private, max-age=10, must-revalidate');

    // 31d. Segmento com TTL já vencido ou <= 5s -> no-store
    const expiredTtlSeg = `https://cdn.signed.example.com/ep01/seg-004.ts?token=abc&expires=${now + 3}`;
    const expiredTtlRes = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(expiredTtlSeg)}`),
      {
        nowSeconds: () => now,
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(tsBytes, {
            status: 200,
            headers: { 'content-type': 'video/mp2t' },
          }),
        }),
      }
    );
    expect(expiredTtlRes.headers.get('cache-control')).toBe('no-store');

    // 31e. Respeita Cache-Control restritivo da origem em stream expirável (no-store e max-age menor)
    const originNoStoreRes = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(longTtlSeg)}`),
      {
        nowSeconds: () => now,
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(tsBytes, {
            status: 200,
            headers: {
              'content-type': 'video/mp2t',
              'cache-control': 'private, no-store',
            },
          }),
        }),
      }
    );
    expect(originNoStoreRes.headers.get('cache-control')).toBe('no-store');

    const originSmallerMaxAgeRes = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(longTtlSeg)}`),
      {
        nowSeconds: () => now,
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(tsBytes, {
            status: 200,
            headers: {
              'content-type': 'video/mp2t',
              'cache-control': 'public, max-age=8',
            },
          }),
        }),
      }
    );
    expect(originSmallerMaxAgeRes.headers.get('cache-control')).toBe('private, max-age=8, must-revalidate');
    expect(originSmallerMaxAgeRes.headers.get('cdn-cache-control')).toBe('no-store');

    // 31f. Respeita Cache-Control restritivo da origem também em stream público (sem sobrescrever com immutable)
    const publicSeg = 'https://cdn-sv01.maximaimg.online/stream/b/bakemonogatari/02.mp4/seg-001.ts';
    const publicOriginPrivateRes = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(publicSeg)}`),
      {
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(tsBytes, {
            status: 200,
            headers: {
              'content-type': 'video/mp2t',
              'cache-control': 'private, max-age=60',
            },
          }),
        }),
      }
    );
    expect(publicOriginPrivateRes.headers.get('cache-control')).toBe('private, max-age=60, must-revalidate');
    expect(publicOriginPrivateRes.headers.get('cdn-cache-control')).toBe('no-store');

    const publicOriginDefaultRes = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(publicSeg)}`),
      {
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(tsBytes, {
            status: 200,
            headers: { 'content-type': 'video/mp2t' },
          }),
        }),
      }
    );
    expect(publicOriginDefaultRes.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('32. protege manifestos sem token na URL principal quando o corpo ou redirect final contém tokens expiráveis', async () => {
    // 32a. URL limpa, porém o manifesto traz segmento/chave assinados no corpo
    const cleanUrl = 'https://cdn.example.com/hls/clean/master.m3u8';
    const bodyWithSignedChildren = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/enc.key?sig=k99"',
      '#EXT-X-MAP:URI="init.mp4?auth=map99"',
      '#EXTINF:5.0,',
      'seg-001.ts?token=bodytok1&expires=1999999999',
      '#EXTINF:5.0,',
      'seg-002.ts',
    ].join('\n');

    const resBodyToken = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(cleanUrl)}`),
      {
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(bodyWithSignedChildren, {
            status: 200,
            headers: { 'content-type': 'application/vnd.apple.mpegurl' },
          }),
        }),
      }
    );
    expect(resBodyToken.status).toBe(200);
    expect(resBodyToken.headers.get('cache-control')).toBe('no-store');
    expect(resBodyToken.headers.get('cdn-cache-control')).toBe('no-store');
    expect(resBodyToken.headers.get('x-hikari-source-expirable')).toBe('1');
    const bodyTokenText = await resBodyToken.text();
    const bodyChildren = (bodyTokenText.match(/\/api\/proxy\/stream\?[^\s"']+/g) ?? []).map(
      (p) => new URL(`http://localhost${p}`)
    );
    const seg2Child = bodyChildren.find((u) => u.searchParams.get('url')?.endsWith('/seg-002.ts'));
    expect(seg2Child?.searchParams.get('ex')).toBe('1');
    expect(seg2Child?.searchParams.get('xsig')).toBeTruthy();

    // 32b. URL limpa redireciona para URL assinada -> manifesto final e filhos sem token na querystring herdam proteção
    const redirectOrigin = 'https://cdn.example.com/hls/redirect-clean/index.m3u8';
    const signedRedirectTarget = 'https://edge09.example.com/hls/ep/index.m3u8?hdnea=exp=1999999999~hmac=abcdef';
    const resRedirectToken = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(redirectOrigin)}`),
      {
        fetchWithRedirects: async () => ({
          finalUrl: signedRedirectTarget,
          response: new Response('#EXTM3U\n#EXTINF:5.0,\nseg-clean-name.ts\n#EXT-X-ENDLIST', {
            status: 200,
            headers: { 'content-type': 'application/vnd.apple.mpegurl' },
          }),
        }),
      }
    );
    expect(resRedirectToken.status).toBe(200);
    expect(resRedirectToken.headers.get('cache-control')).toBe('no-store');
    expect(resRedirectToken.headers.get('cdn-cache-control')).toBe('no-store');
    expect(resRedirectToken.headers.get('x-hikari-source-expirable')).toBe('1');
    const redirectText = await resRedirectToken.text();
    const redirectedSeg = new URL(
      `http://localhost${redirectText.split('\n').find((l) => l.includes('seg-clean-name.ts'))!.trim()}`
    );
    expect(redirectedSeg.searchParams.get('ex')).toBe('1');
    expect(redirectedSeg.searchParams.get('xsig')).toBeTruthy();
  });

  it('33. opera fail-safe caso a detecção de tokens lance exceção sem interromper reprodução nem aplicar cache indevido', async () => {
    const throwingDetector = () => {
      throw new Error('regex failure');
    };

    const manifestUrl = 'https://cdn.example.com/hls/master.m3u8';
    const manifestRes = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(manifestUrl)}`),
      {
        detectExpirableTokens: throwingDetector,
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response('#EXTM3U\n#EXTINF:5.0,\nseg-001.ts\n#EXT-X-ENDLIST', {
            status: 200,
            headers: { 'content-type': 'application/vnd.apple.mpegurl' },
          }),
        }),
      }
    );
    expect(manifestRes.status).toBe(200);
    expect(manifestRes.headers.get('cache-control')).toBe('no-store');
    expect(manifestRes.headers.get('x-hikari-source-expirable')).toBe('1');

    const segUrl = 'https://cdn.example.com/hls/seg-001.ts';
    const segBytes = new Uint8Array([0x47, 0x40, 0x00, 0x77]);
    const segRes = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(segUrl)}`),
      {
        detectExpirableTokens: throwingDetector,
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(segBytes, {
            status: 200,
            headers: { 'content-type': 'video/mp2t' },
          }),
        }),
      }
    );
    expect(segRes.status).toBe(200);
    expect(segRes.headers.get('cache-control')).toBe('no-store');
    expect(segRes.headers.get('x-hikari-source-expirable')).toBe('1');
    expect(Array.from(new Uint8Array(await segRes.arrayBuffer()))).toEqual(Array.from(segBytes));
  });
});
