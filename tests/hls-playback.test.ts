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
  MAX_HLS_REWRITE_DEPTH,
  rewriteM3u8Playlist,
} from '@/lib/proxy-signing';
import { diagnoseEpisodeSources, diagnoseVideoSource } from '@/lib/source-diagnostics';
import { getUpstreamHeaders, handleProxyStreamRequest } from '@/lib/stream-proxy';
import type { PlayableSource } from '@/lib/types';
import {
  collectEpisodeSources,
  getNextFallbackSourceIndex,
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
});
