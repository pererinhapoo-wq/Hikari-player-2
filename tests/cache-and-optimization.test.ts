import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getOptimizedImageProps,
  IMAGE_WIDTH_LIMITS,
  MAX_IMAGE_BYTES,
  resizeImageUrlForWidth,
} from '@/lib/image-optimization';
import {
  buildSignedProxyPath,
  getStableProxyExpiry,
  PROXY_EXP_BUCKET_SECONDS,
} from '@/lib/proxy-signing';
import { resolveProxyPlayUrl } from '@/lib/server-fns';
import { handleProxyStreamRequest } from '@/lib/stream-proxy';
import { normalizeVideoSource } from '@/lib/video-sources';
import { Route as AdminRoute } from '@/routes/admin';
import { Route as EpisodeRoute } from '@/routes/e/$id';
import { Route as HomeRoute } from '@/routes/index';

describe('Assinatura estável (bucket de 6h) e cache do proxy', () => {
  beforeEach(() => {
    process.env.PLAYER_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
  });

  it('gera a mesma URL assinada de segmento em duas chamadas com 5 minutos de intervalo na mesma janela de 6h', () => {
    const t0 = 1_795_003_200; // dentro de uma janela fixa de 6h
    const t5MinLater = t0 + 300;
    const segUrl = 'https://cdn-sv01.maximaimg.online/stream/b/ep01/seg-001.ts';

    expect(PROXY_EXP_BUCKET_SECONDS).toBe(21600);
    expect(getStableProxyExpiry(t0)).toBe(getStableProxyExpiry(t5MinLater));

    const urlAtT0 = buildSignedProxyPath(segUrl, undefined, t0);
    const urlAtT5Min = buildSignedProxyPath(segUrl, undefined, t5MinLater);
    expect(urlAtT0).toBe(urlAtT5Min);

    const parsed = new URL(`http://localhost${urlAtT0}`);
    const exp = Number(parsed.searchParams.get('exp'));
    expect(exp % PROXY_EXP_BUCKET_SECONDS).toBe(0);
    expect(exp).toBeGreaterThan(t0 + PROXY_EXP_BUCKET_SECONDS);

    // Também consistente em resolveProxyPlayUrl (com e sem WORKER_BASE)
    expect(resolveProxyPlayUrl(segUrl, '', t0)).toBe(resolveProxyPlayUrl(segUrl, '', t5MinLater));
    expect(
      resolveProxyPlayUrl(segUrl, 'https://proxy.example.workers.dev', t0)
    ).toBe(
      resolveProxyPlayUrl(segUrl, 'https://proxy.example.workers.dev', t5MinLater)
    );
  });

  it('responde segmentos binários com Cache-Control e CDN-Cache-Control public, max-age=31536000, immutable e sem private', async () => {
    const segUrl = 'https://cdn-sv01.maximaimg.online/stream/b/ep01/seg-001.ts';
    const signedPath = buildSignedProxyPath(segUrl);
    const tsBytes = new Uint8Array([0x47, 0x40, 0x00, 0x10, 0xaa, 0xbb]);

    const res = await handleProxyStreamRequest(new Request(`http://localhost${signedPath}`), {
      fetchWithRedirects: async (url) => ({
        finalUrl: url,
        response: new Response(tsBytes, {
          status: 200,
          headers: {
            'content-type': 'video/mp2t',
            'content-length': String(tsBytes.byteLength),
          },
        }),
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('cdn-cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('cache-control')).not.toContain('private');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('responde manifestos M3U8 com Cache-Control public, max-age=5, stale-while-revalidate=30 e sem private', async () => {
    const manifestUrl = 'https://cdn-sv01.maximaimg.online/stream/b/ep01/index.m3u8';
    const signedPath = buildSignedProxyPath(manifestUrl);
    const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg-001.ts\n#EXT-X-ENDLIST';

    const res = await handleProxyStreamRequest(new Request(`http://localhost${signedPath}`), {
      fetchWithRedirects: async (url) => ({
        finalUrl: url,
        response: new Response(playlist, {
          status: 200,
          headers: { 'content-type': 'application/vnd.apple.mpegurl' },
        }),
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=5, stale-while-revalidate=30');
    expect(res.headers.get('cdn-cache-control')).toBe(
      'public, max-age=5, stale-while-revalidate=30'
    );
    expect(res.headers.get('cache-control')).not.toContain('private');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('mantém resposta OPTIONS do proxy com Access-Control-Allow-Origin *', async () => {
    const streamRouteSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/routes/api/proxy/stream.ts'),
      'utf8'
    );
    expect(streamRouteSource).toContain('OPTIONS:');
    expect(streamRouteSource).toContain("'Access-Control-Allow-Origin': '*'");
  });

  it('nunca aplica cache público imutável de 1 ano para URLs R2 (com ou sem X-Amz-*) no proxy Vercel e preserva MP4 comum, Vercel Blob e cabeçalhos restritivos', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const toAmzDate = (unixSec: number) =>
      new Date(unixSec * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const unsignedR2 =
      'https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/z333/229033.mp4';
    const signedR2 =
      `https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/z333/229033.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=${toAmzDate(nowSec - 60)}&X-Amz-Expires=7200&X-Amz-Signature=abc123`;
    const expiredSignedR2 =
      'https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/z333/229033.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20250101T000000Z&X-Amz-Expires=7200&X-Amz-Signature=abc123';
    const publicMp4 = 'https://cdn.example.com/anime/ep01.mp4';
    const blobMp4 = 'https://abc123.public.blob.vercel-storage.com/mirrors/anime/ep01.mp4';
    const mp4Bytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);

    // 1. R2 sem assinatura -> Cache-Control: no-store mesmo se a origem tentar publicar cache longo
    const resUnsignedR2 = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(unsignedR2, undefined, nowSec)}`),
      {
        nowSeconds: () => nowSec,
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(mp4Bytes, {
            status: 200,
            headers: {
              'content-type': 'video/mp4',
              'cache-control': 'public, max-age=31536000',
            },
          }),
        }),
      }
    );
    expect(resUnsignedR2.status).toBe(200);
    expect(resUnsignedR2.headers.get('cache-control')).toBe('no-store');
    expect(resUnsignedR2.headers.get('cdn-cache-control')).toBe('no-store');
    expect(resUnsignedR2.headers.get('cache-control')).not.toContain('immutable');
    expect(resUnsignedR2.headers.get('cache-control')).not.toContain('31536000');
    expect(resUnsignedR2.headers.get('x-hikari-source-expirable')).toBe('1');

    // 2. R2 com X-Amz-* válido -> nunca immutable nem public; respeita CDN no-store e TTL curto privado
    const resSignedR2 = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(signedR2, undefined, nowSec)}`),
      {
        nowSeconds: () => nowSec,
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(mp4Bytes, {
            status: 200,
            headers: { 'content-type': 'video/mp4' },
          }),
        }),
      }
    );
    expect(resSignedR2.status).toBe(200);
    expect(resSignedR2.headers.get('cache-control')).toBe('private, max-age=30, must-revalidate');
    expect(resSignedR2.headers.get('cdn-cache-control')).toBe('no-store');
    expect(resSignedR2.headers.get('cache-control')).not.toContain('immutable');
    expect(resSignedR2.headers.get('x-hikari-source-expirable')).toBe('1');

    // 3. R2 com X-Amz-* vencido ou cabeçalho restritivo da origem -> no-store
    const resExpiredR2 = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(expiredSignedR2, undefined, nowSec)}`),
      {
        nowSeconds: () => nowSec,
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(mp4Bytes, {
            status: 200,
            headers: { 'content-type': 'video/mp4' },
          }),
        }),
      }
    );
    expect(resExpiredR2.headers.get('cache-control')).toBe('no-store');
    expect(resExpiredR2.headers.get('cdn-cache-control')).toBe('no-store');

    const resRestrictiveR2 = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(signedR2, undefined, nowSec)}`),
      {
        nowSeconds: () => nowSec,
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(mp4Bytes, {
            status: 200,
            headers: {
              'content-type': 'video/mp4',
              'cache-control': 'private, no-cache',
            },
          }),
        }),
      }
    );
    expect(resRestrictiveR2.headers.get('cache-control')).toBe('no-store');
    expect(resRestrictiveR2.headers.get('cdn-cache-control')).toBe('no-store');

    // 4. MP4 público comum mantém cache existente
    const resPublicMp4 = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(publicMp4, undefined, nowSec)}`),
      {
        nowSeconds: () => nowSec,
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(mp4Bytes, {
            status: 200,
            headers: { 'content-type': 'video/mp4' },
          }),
        }),
      }
    );
    expect(resPublicMp4.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(resPublicMp4.headers.get('cdn-cache-control')).toBe('public, max-age=31536000, immutable');
    expect(resPublicMp4.headers.get('x-hikari-source-expirable')).toBeNull();

    // 5. MP4 permanente do Vercel Blob mantém reprodução direta e política de cache existente
    expect(normalizeVideoSource(blobMp4, 1)?.needsProxy).toBe(false);
    expect(normalizeVideoSource(blobMp4, 1)?.isExpirable).toBeUndefined();
    const resBlobMp4 = await handleProxyStreamRequest(
      new Request(`http://localhost${buildSignedProxyPath(blobMp4, undefined, nowSec)}`),
      {
        nowSeconds: () => nowSec,
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(mp4Bytes, {
            status: 200,
            headers: { 'content-type': 'video/mp4' },
          }),
        }),
      }
    );
    expect(resBlobMp4.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(resBlobMp4.headers.get('cdn-cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('protege URLs Google Video (/videoplayback) acima de 2.048 chars com ex=1/xsig e Cache-Control no-store preservando Range', async () => {
    const nowSec = 1_800_000_000;
    const googleVideoUrl = `https://rr3---sn-example-002.googlevideo.com/videoplayback?expire=${nowSec + 7200}&ei=fake_ei&ip=198.51.100.1&id=o-FAKEID456&itag=18&source=blogger&mime=video%2Fmp4&sparams=expire%2Cei%2Cip%2Cid%2Citag%2Csource%2Cmime&sig=FAKE_SIG_${'A'.repeat(2400)}&lsig=FAKE_LSIG_999`;
    expect(googleVideoUrl.length).toBeGreaterThan(2048);
    expect(googleVideoUrl.length).toBeLessThan(8192);

    const signedPath = buildSignedProxyPath(googleVideoUrl, undefined, nowSec);
    const parsedSigned = new URL(`http://localhost${signedPath}`);
    expect(parsedSigned.searchParams.get('url')).toBe(googleVideoUrl);
    expect(parsedSigned.searchParams.get('ex')).toBe('1');
    expect(parsedSigned.searchParams.get('xsig')).toBeTruthy();

    const workerUrl = new URL(
      resolveProxyPlayUrl(
        googleVideoUrl,
        'https://proxy.example.workers.dev',
        nowSec,
        null,
        true
      )
    );
    expect(workerUrl.searchParams.get('ex')).toBe('1');
    expect(workerUrl.searchParams.get('xsig')).toBeTruthy();

    const mp4Bytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    let capturedUpstreamUrl = '';
    let capturedRange: string | null = null;

    const res = await handleProxyStreamRequest(
      new Request(`http://localhost${signedPath}`, {
        headers: { Range: 'bytes=0-7' },
      }),
      {
        nowSeconds: () => nowSec,
        fetchWithRedirects: async (url, init) => {
          capturedUpstreamUrl = url;
          capturedRange = new Headers(init?.headers).get('range');
          return {
            finalUrl: url,
            response: new Response(mp4Bytes, {
              status: 206,
              headers: {
                'content-type': 'video/mp4',
                'content-length': '8',
                'content-range': 'bytes 0-7/1024',
                'accept-ranges': 'bytes',
                'cache-control': 'private, max-age=21600',
              },
            }),
          };
        },
      }
    );

    expect(res.status).toBe(206);
    expect(capturedUpstreamUrl).toBe(googleVideoUrl);
    expect(capturedRange).toBe('bytes=0-7');
    expect(res.headers.get('content-range')).toBe('bytes 0-7/1024');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('cdn-cache-control')).toBe('no-store');
    expect(res.headers.get('cache-control')).not.toContain('immutable');
    expect(res.headers.get('cache-control')).not.toContain('31536000');
    expect(res.headers.get('x-hikari-source-expirable')).toBe('1');
  });
});

describe('Cache das rotas de página e otimização de imagens/JS', () => {
  it('configura cabeçalhos de cache corretos para Home, /e/$id e /admin', async () => {
    const homeHeaders = await HomeRoute.options.headers?.({} as never);
    expect(homeHeaders).toMatchObject({
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900',
    });

    const episodeHeaders = await EpisodeRoute.options.headers?.({} as never);
    expect(episodeHeaders).toMatchObject({
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400',
    });

    const adminHeaders = await AdminRoute.options.headers?.({} as never);
    expect(adminHeaders).toMatchObject({
      'Cache-Control': 'private, no-store',
    });
  });

  it('gera srcset 1x/2x por uso (capa 230, miniatura 120, banner 1280) e atributos lazy/async/draggable vs LCP', () => {
    expect(IMAGE_WIDTH_LIMITS).toEqual({
      capa: 230,
      miniatura: 120,
      banner: 1280,
    });
    expect(MAX_IMAGE_BYTES).toBe(60 * 1024);

    const tmdbOriginal = 'https://image.tmdb.org/t/p/original/poster.jpg';

    const mini = getOptimizedImageProps(tmdbOriginal, 'miniatura');
    expect(mini.src).toBe('https://image.tmdb.org/t/p/w154/poster.jpg');
    expect(mini.srcSet).toBe(
      'https://image.tmdb.org/t/p/w154/poster.jpg 1x, https://image.tmdb.org/t/p/w300/poster.jpg 2x'
    );
    expect(mini.loading).toBe('lazy');
    expect(mini.decoding).toBe('async');
    expect(mini.draggable).toBe(false);
    expect(mini.fetchPriority).toBeUndefined();

    const capa = getOptimizedImageProps(tmdbOriginal, 'capa');
    expect(capa.src).toBe('https://image.tmdb.org/t/p/w300/poster.jpg');
    expect(capa.srcSet).toBe(
      'https://image.tmdb.org/t/p/w300/poster.jpg 1x, https://image.tmdb.org/t/p/w500/poster.jpg 2x'
    );
    expect(capa.loading).toBe('lazy');
    expect(capa.fetchPriority).toBeUndefined();

    const bannerLcp = getOptimizedImageProps(tmdbOriginal, 'banner', { isLcp: true });
    expect(bannerLcp.src).toBe('https://image.tmdb.org/t/p/w1280/poster.jpg');
    expect(bannerLcp.loading).toBe('eager');
    expect(bannerLcp.decoding).toBe('async');
    expect(bannerLcp.draggable).toBe(false);
    expect(bannerLcp.fetchPriority).toBe('high');

    // Não altera URLs assinadas
    const signedImg = 'https://cdn.example.com/poster.jpg?X-Amz-Signature=abc123&Expires=9999999';
    expect(resizeImageUrlForWidth(signedImg, 120)).toBe(signedImg);
  });

  it('garante que hls.js só é importado dinamicamente em EpisodePlayer.tsx e não existe em index.tsx ou admin.tsx', () => {
    const homeSource = fs.readFileSync(path.resolve(process.cwd(), 'src/routes/index.tsx'), 'utf8');
    const adminSource = fs.readFileSync(path.resolve(process.cwd(), 'src/routes/admin.tsx'), 'utf8');
    const playerSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/EpisodePlayer.tsx'),
      'utf8'
    );

    expect(homeSource).not.toContain('hls.js');
    expect(adminSource).not.toContain('hls.js');
    expect(playerSource).toContain("import('hls.js')");
    expect(playerSource).not.toMatch(/^\s*import\s+.*from\s+['"]hls\.js['"]/m);
  });
});
