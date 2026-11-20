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
