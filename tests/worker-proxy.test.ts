import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProxyDepthSignature,
  createProxyRefererSignature,
  createProxySignature,
  verifyProxySignature,
} from '@/lib/proxy-signing';
import { resolveProxyPlayUrl } from '@/lib/server-fns';
import {
  type CfRequestInit,
  createWorkerDepthSignature,
  createWorkerProxySignature,
  createWorkerRefererSignature,
  getStableSegmentExpiry,
  handleWorkerProxyRequest,
  resolveUpstreamReferer,
  resolveUpstreamRefererCandidates,
  verifyWorkerProxyReferer,
  verifyWorkerProxySignature,
  type WorkerEnv,
  type WorkerExecutionContext,
} from '../worker/src/index';

const TEST_SECRET = '0123456789abcdef0123456789abcdef';

function createMemoryEdgeCache(): Cache {
  const store = new Map<string, Response>();
  return {
    async match(request: RequestInfo | URL) {
      const key = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url;
      const found = store.get(key);
      return found ? found.clone() : undefined;
    },
    async put(request: RequestInfo | URL, response: Response) {
      const key = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url;
      store.set(key, response.clone());
    },
    async delete(request: RequestInfo | URL) {
      const key = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url;
      return store.delete(key);
    },
    async add() {},
    async addAll() {},
    async keys() {
      return [];
    },
    async matchAll() {
      return [];
    },
  } as Cache;
}

describe('WORKER_BASE e rollback em server-fns.ts', () => {
  beforeEach(() => {
    process.env.PLAYER_SESSION_SECRET = TEST_SECRET;
  });

  it('mantém /api/proxy/stream na Vercel quando WORKER_BASE está ausente ou vazia', () => {
    const target = 'https://cdn-sv01.maximaimg.online/stream/b/bakemonogatari/01.mp4/index.m3u8';
    expect(resolveProxyPlayUrl(target, undefined)).toMatch(/^\/api\/proxy\/stream\?url=/);
    expect(resolveProxyPlayUrl(target, '')).toMatch(/^\/api\/proxy\/stream\?url=/);
    expect(resolveProxyPlayUrl(target, '   ')).toMatch(/^\/api\/proxy\/stream\?url=/);
  });

  it('aponta playUrl para o Worker quando WORKER_BASE está definida e normaliza barras/sufixo', () => {
    const target = 'https://cdn-sv01.maximaimg.online/stream/b/bakemonogatari/01.mp4/index.m3u8';
    const url1 = resolveProxyPlayUrl(target, 'https://hikari-media-proxy.example.workers.dev');
    const url2 = resolveProxyPlayUrl(target, 'https://hikari-media-proxy.example.workers.dev/');
    const url3 = resolveProxyPlayUrl(
      target,
      'https://hikari-media-proxy.example.workers.dev/api/proxy/stream'
    );

    expect(url1).toMatch(/^https:\/\/hikari-media-proxy\.example\.workers\.dev\/api\/proxy\/stream\?url=/);
    expect(url2).toBe(url1);
    expect(url3).toBe(url1);
  });

  it('faz fallback automático para /api/proxy/stream se WORKER_BASE for inválida', () => {
    const target = 'https://cdn-sv01.maximaimg.online/stream/b/bakemonogatari/01.mp4/index.m3u8';
    expect(resolveProxyPlayUrl(target, 'not-a-valid-url')).toMatch(/^\/api\/proxy\/stream\?url=/);
  });
});

describe('Cloudflare Worker Edge Proxy', () => {
  const env: WorkerEnv = {
    PLAYER_SESSION_SECRET: TEST_SECRET,
    PLAYER_MAXIMAIMG_REFERER: 'https://api.anivideo.net/',
  };

  beforeEach(() => {
    process.env.PLAYER_SESSION_SECRET = TEST_SECRET;
  });

  it('mantém interoperabilidade total de HMAC entre Vercel (Node crypto) e Worker (Web Crypto)', async () => {
    const target = 'https://cdn-sv01.maximaimg.online/stream/b/bakemonogatari/01.mp4/index.m3u8';
    const exp = 2_000_000_000;

    const nodeSig = createProxySignature(target, exp);
    const workerSig = await createWorkerProxySignature(target, exp, TEST_SECRET);

    expect(workerSig).toBe(nodeSig);
    expect(await verifyWorkerProxySignature(target, String(exp), nodeSig, TEST_SECRET, 1_900_000_000)).toBe(true);
    expect(verifyProxySignature(target, String(exp), workerSig)).toBe(true);
  });

  it('remove header Origin, envia Referer do provedor + UA Chrome, usa cf.cacheEverything e reescreve M3U8 com assinatura estável', async () => {
    const manifestUrl = 'https://cdn-sv01.maximaimg.online/stream/b/bakemonogatari/01.mp4/index.m3u8';
    const exp = 2_000_000_000;
    const sig = createProxySignature(manifestUrl, exp);
    const requestUrl = `https://hikari-media-proxy.workers.dev/api/proxy/stream?url=${encodeURIComponent(manifestUrl)}&exp=${exp}&sig=${sig}`;

    let capturedInit: CfRequestInit | undefined;
    const fakePlaylist = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:10',
      '#EXTINF:10.0,',
      'seg-001.ts',
      '#EXTINF:10.0,',
      'seg-002.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');

    const fetcher = vi.fn(async (_input: string, init?: CfRequestInit) => {
      capturedInit = init;
      return new Response(fakePlaylist, {
        status: 200,
        headers: {
          'content-type': 'application/vnd.apple.mpegurl',
        },
      });
    });

    const req1 = new Request(requestUrl, {
      headers: {
        Origin: 'https://hikari-player-2.vercel.app',
        Referer: 'https://hikari-player-2.vercel.app/',
      },
    });
    const res1 = await handleWorkerProxyRequest(req1, env, undefined, {
      fetcher,
      edgeCache: null,
      nowSeconds: () => 1_795_000_100,
    });

    expect(res1.status).toBe(200);
    expect(res1.headers.get('access-control-allow-origin')).toBe('*');
    expect(res1.headers.get('cache-control')).toBe('public, max-age=5');

    const sentHeaders = new Headers(capturedInit?.headers);
    expect(sentHeaders.has('origin')).toBe(false);
    expect(sentHeaders.get('referer')).toBe('https://api.anivideo.net/');
    expect(sentHeaders.get('user-agent')).toContain('Chrome/');
    expect(capturedInit?.cf).toEqual({ cacheEverything: true, cacheTtl: 5 });

    const body1 = await res1.text();

    // Segunda requisição 30 segundos depois com outra assinatura de entrada: segmentos mantêm assinatura idêntica
    const exp2 = exp + 30;
    const sig2 = createProxySignature(manifestUrl, exp2);
    const req2 = new Request(
      `https://hikari-media-proxy.workers.dev/api/proxy/stream?url=${encodeURIComponent(manifestUrl)}&exp=${exp2}&sig=${sig2}`
    );
    const res2 = await handleWorkerProxyRequest(req2, env, undefined, {
      fetcher,
      edgeCache: null,
      nowSeconds: () => 1_795_000_130,
    });
    const body2 = await res2.text();

    expect(body2).toBe(body1);
    const stableExp = getStableSegmentExpiry(1_795_000_100);
    expect(body1).toContain(`exp=${stableExp}`);
    expect(body1).not.toContain(`exp=${exp}`);
  });

  it('serve segmentos com Cache-Control imutável, cf.cacheTtl=31536000, ACAO * e HIT na segunda requisição', async () => {
    const segUrl = 'https://cdn-sv01.maximaimg.online/stream/b/bakemonogatari/01.mp4/seg-001.ts';
    const exp = 2_000_000_000;
    const sig = await createWorkerProxySignature(segUrl, exp, TEST_SECRET);
    const workerUrl = `https://hikari-media-proxy.workers.dev/api/proxy/stream?url=${encodeURIComponent(segUrl)}&exp=${exp}&sig=${sig}`;

    const rawBytes = new Uint8Array([0x47, 0x40, 0x00, 0xff, 0xfe, 0x80, 0x11, 0x22]);
    let capturedCf: CfRequestInit['cf'];
    const fetcher = vi.fn(async (_input: string, init?: CfRequestInit) => {
      capturedCf = init?.cf;
      return new Response(rawBytes, {
        status: 200,
        headers: {
          'content-type': 'video/mp2t',
          'content-length': String(rawBytes.byteLength),
          'cf-cache-status': 'MISS',
        },
      });
    });

    const edgeCache = createMemoryEdgeCache();
    const pending: Promise<unknown>[] = [];
    const ctx: WorkerExecutionContext = {
      waitUntil(p) {
        pending.push(p);
      },
    };

    // 1ª requisição -> MISS (vai à origem com cf.cacheEverything=true e cacheTtl=31536000)
    const res1 = await handleWorkerProxyRequest(
      new Request(workerUrl, { headers: { Origin: 'https://hikari-player-2.vercel.app' } }),
      env,
      ctx,
      { fetcher, edgeCache, nowSeconds: () => 1_795_000_000 }
    );
    await Promise.all(pending);

    expect(res1.status).toBe(200);
    expect(res1.headers.get('access-control-allow-origin')).toBe('*');
    expect(res1.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res1.headers.get('cf-cache-status')).toBe('MISS');
    expect(capturedCf).toEqual({ cacheEverything: true, cacheTtl: 31536000 });
    expect(Array.from(new Uint8Array(await res1.arrayBuffer()))).toEqual(Array.from(rawBytes));
    expect(fetcher).toHaveBeenCalledTimes(1);

    // 2ª requisição -> HIT na borda sem chamar a origem
    const res2 = await handleWorkerProxyRequest(
      new Request(workerUrl, { headers: { Origin: 'https://hikari-player-2.vercel.app' } }),
      env,
      ctx,
      { fetcher, edgeCache, nowSeconds: () => 1_795_000_005 }
    );
    expect(res2.status).toBe(200);
    expect(res2.headers.get('access-control-allow-origin')).toBe('*');
    expect(res2.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res2.headers.get('cf-cache-status')).toBe('HIT');
    expect(Array.from(new Uint8Array(await res2.arrayBuffer()))).toEqual(Array.from(rawBytes));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('repassa Range, responde 206 Partial Content com Content-Range e bloqueia SSRF/assinatura inválida', async () => {
    const mp4Url = 'https://cdn-sv01.maximaimg.online/files/ep01.mp4';
    const exp = 2_000_000_000;
    const sig = await createWorkerProxySignature(mp4Url, exp, TEST_SECRET);
    const workerUrl = `https://hikari-media-proxy.workers.dev/api/proxy/stream?url=${encodeURIComponent(mp4Url)}&exp=${exp}&sig=${sig}`;

    const chunk = new Uint8Array([0x00, 0x00, 0x00, 0x18]);
    let capturedRange: string | null = null;

    const fetcher = vi.fn(async (_input: string, init?: CfRequestInit) => {
      capturedRange = new Headers(init?.headers).get('range');
      return new Response(chunk, {
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-length': '4',
          'content-range': 'bytes 0-3/1024',
          'accept-ranges': 'bytes',
        },
      });
    });

    const res = await handleWorkerProxyRequest(
      new Request(workerUrl, { headers: { Range: 'bytes=0-3' } }),
      env,
      undefined,
      { fetcher, edgeCache: createMemoryEdgeCache(), nowSeconds: () => 1_795_000_000 }
    );

    expect(capturedRange).toBe('bytes=0-3');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-3/1024');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');

    // Assinatura adulterada -> 403
    const badRes = await handleWorkerProxyRequest(
      new Request(`${workerUrl.replace(sig, 'assinatura_invalida')}`),
      env
    );
    expect(badRes.status).toBe(403);

    // SSRF -> 502
    const internalUrl = 'http://127.0.0.1:8080/internal.ts';
    const internalSig = await createWorkerProxySignature(internalUrl, exp, TEST_SECRET);
    const ssrfRes = await handleWorkerProxyRequest(
      new Request(
        `https://hikari-media-proxy.workers.dev/api/proxy/stream?url=${encodeURIComponent(internalUrl)}&exp=${exp}&sig=${internalSig}`
      ),
      env,
      undefined,
      { nowSeconds: () => 1_795_000_000 }
    );
    expect(ssrfRes.status).toBe(502);
  });

  it('resolve Referer por mapa em vars (PLAYER_REFERER_MAP) com preferência para host mais específico e fallback', () => {
    const mappedEnv: WorkerEnv = {
      PLAYER_SESSION_SECRET: TEST_SECRET,
      PLAYER_MAXIMAIMG_REFERER: 'https://api.anivideo.net/',
      PLAYER_REFERER_MAP: JSON.stringify({
        'maximaimg.online': 'https://api.anivideo.net/',
        'cdn-sv02.maximaimg.online': 'https://player.provedor2.net/',
        'cdn.outroprovedor.com': 'https://site.outroprovedor.com/',
      }),
    };

    expect(
      resolveUpstreamReferer(new URL('https://cdn-sv01.maximaimg.online/ep1/index.m3u8'), mappedEnv)
    ).toBe('https://api.anivideo.net/');
    expect(
      resolveUpstreamReferer(new URL('https://cdn-sv02.maximaimg.online/ep1/index.m3u8'), mappedEnv)
    ).toBe('https://player.provedor2.net/');
    expect(
      resolveUpstreamReferer(new URL('https://cdn.outroprovedor.com/video.ts'), mappedEnv)
    ).toBe('https://site.outroprovedor.com/');

    // Fallback quando PLAYER_REFERER_MAP ausente ou inválido
    const fallbackEnv: WorkerEnv = {
      PLAYER_SESSION_SECRET: TEST_SECRET,
      PLAYER_MAXIMAIMG_REFERER: 'https://api.anivideo.net/',
      PLAYER_REFERER_MAP: '{json-invalido',
    };
    expect(
      resolveUpstreamReferer(new URL('https://cdn-sv01.maximaimg.online/ep1/index.m3u8'), fallbackEnv)
    ).toBe('https://api.anivideo.net/');
    expect(
      resolveUpstreamReferer(new URL('https://cdn.generico.com/video.mp4'), fallbackEnv)
    ).toBe('https://cdn.generico.com/');

    // Subdomínio cdn-* qualquer usa https://www.anitube.biz/ como principal e antigos como fallback
    const cdnGenericUrl = new URL('https://cdn-s04.outrohost.net/video/index.m3u8');
    expect(resolveUpstreamReferer(cdnGenericUrl, fallbackEnv)).toBe('https://www.anitube.biz/');
    expect(resolveUpstreamRefererCandidates(cdnGenericUrl, fallbackEnv)).toEqual([
      'https://www.anitube.biz/',
      'https://api.anivideo.net/',
      'https://www.coempregos.com.br/',
      'https://cdn-s04.outrohost.net/',
      '',
    ]);
  });

  it('envia Referer https://www.anitube.biz/ para mywallpaper-4k-image.net (e faz pass-through binário video/mp2t de segmentos .webp)', async () => {
    const segUrl = 'https://cdn-s01.mywallpaper-4k-image.net/stream/ep01/seg-001.webp';
    const exp = 2_000_000_000;
    const sig = await createWorkerProxySignature(segUrl, exp, TEST_SECRET);
    const workerUrl = `https://hikari-media-proxy.workers.dev/api/proxy/stream?url=${encodeURIComponent(segUrl)}&exp=${exp}&sig=${sig}`;

    const tsBytes = new Uint8Array([0x47, 0x40, 0x00, 0x10, 0xaa, 0xbb]);
    let capturedHeaders: Headers | null = null;

    const fetcher = vi.fn(async (_input: string, init?: CfRequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(tsBytes, {
        status: 200,
        headers: {
          'content-type': 'image/webp',
          'content-length': String(tsBytes.byteLength),
        },
      });
    });

    const res = await handleWorkerProxyRequest(
      new Request(workerUrl, { headers: { Origin: 'https://hikari-player-2.vercel.app' } }),
      env,
      undefined,
      { fetcher, edgeCache: createMemoryEdgeCache(), nowSeconds: () => 1_795_000_000 }
    );

    expect(capturedHeaders).not.toBeNull();
    expect(capturedHeaders!.get('referer')).toBe('https://www.anitube.biz/');
    expect(capturedHeaders!.has('origin')).toBe(false);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp2t');
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(tsBytes));
  });

  it('suporta reescrita recursiva até profundidade 2, retry 403 com fallback de Referer e sinaliza M3U8 expirável no Worker', async () => {
    const masterUrl = 'https://host-a.example.com/master.m3u8';
    const variantUrl = 'https://host-b.example.com/var/stream';
    const subVariantUrl = 'https://host-c.example.com/sub/index.m3u8';
    const segUrl = 'https://host-d.example.com/seg.ts?token=tmp123';
    const tooDeepUrl = 'https://host-e.example.com/deep.m3u8';

    const exp = 2_000_000_000;
    const nodeDepthSig = createProxyDepthSignature(variantUrl, exp, 1);
    const workerDepthSig = await createWorkerDepthSignature(variantUrl, exp, 1, TEST_SECRET);
    expect(workerDepthSig).toBe(nodeDepthSig);

    const seenReferersByUrl = new Map<string, Array<string | null>>();
    const fetcher = vi.fn(async (input: string, init?: CfRequestInit) => {
      const ref = new Headers(init?.headers).get('referer');
      const arr = seenReferersByUrl.get(input) ?? [];
      arr.push(ref);
      seenReferersByUrl.set(input, arr);

      if (input === masterUrl) {
        return new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n${variantUrl}`, {
          status: 200,
          headers: { 'content-type': 'application/vnd.apple.mpegurl' },
        });
      }
      if (input === variantUrl) {
        return new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500\n${subVariantUrl}`, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      }
      if (input === subVariantUrl) {
        return new Response(
          `#EXTM3U\n#EXTINF:5.0,\n${segUrl}\n#EXT-X-STREAM-INF:BANDWIDTH=100\n${tooDeepUrl}`,
          { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } }
        );
      }
      if (input === segUrl) {
        // Retorna 403 com Referer do host, sucesso sem Referer
        if (ref !== null) {
          return new Response('Forbidden', { status: 403 });
        }
        return new Response(new Uint8Array([0x47, 0x40, 0x00, 0x55]), {
          status: 200,
          headers: { 'content-type': 'video/mp2t' },
        });
      }
      return new Response('#EXTM3U\n#EXTINF:5.0,\nend.ts', {
        status: 200,
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      });
    });

    const masterSig = await createWorkerProxySignature(masterUrl, exp, TEST_SECRET);
    const res0 = await handleWorkerProxyRequest(
      new Request(
        `https://hikari-media-proxy.workers.dev/api/proxy/stream?url=${encodeURIComponent(masterUrl)}&exp=${exp}&sig=${masterSig}`
      ),
      env,
      undefined,
      { fetcher, edgeCache: null, nowSeconds: () => 1_795_000_000 }
    );
    expect(res0.status).toBe(200);
    const body0 = await res0.text();
    const path1 = body0.split('\n').find((l) => l.includes(encodeURIComponent(variantUrl)))!.trim();

    const res1 = await handleWorkerProxyRequest(
      new Request(`https://hikari-media-proxy.workers.dev${path1}`),
      env,
      undefined,
      { fetcher, edgeCache: null, nowSeconds: () => 1_795_000_000 }
    );
    expect(res1.status).toBe(200);
    const body1 = await res1.text();
    const path2 = body1.split('\n').find((l) => l.includes(encodeURIComponent(subVariantUrl)))!.trim();

    const res2 = await handleWorkerProxyRequest(
      new Request(`https://hikari-media-proxy.workers.dev${path2}`),
      env,
      undefined,
      { fetcher, edgeCache: null, nowSeconds: () => 1_795_000_000 }
    );
    expect(res2.status).toBe(200);
    expect(res2.headers.get('x-hikari-source-expirable')).toBe('1');
    const body2 = await res2.text();

    const segPath = body2.split('\n').find((l) => l.includes(encodeURIComponent(segUrl)))!.trim();
    const resSeg = await handleWorkerProxyRequest(
      new Request(`https://hikari-media-proxy.workers.dev${segPath}`),
      env,
      undefined,
      { fetcher, edgeCache: null, nowSeconds: () => 1_795_000_000 }
    );
    expect(resSeg.status).toBe(200);
    expect(resSeg.headers.get('cache-control')).not.toContain('immutable');
    expect(seenReferersByUrl.get(segUrl)).toEqual(['https://host-d.example.com/', null]);

    const deepPath = body2.split('\n').find((l) => l.includes(encodeURIComponent(tooDeepUrl)))!.trim();
    const resDeep = await handleWorkerProxyRequest(
      new Request(`https://hikari-media-proxy.workers.dev${deepPath}`),
      env,
      undefined,
      { fetcher, edgeCache: null, nowSeconds: () => 1_795_000_000 }
    );
    expect(resDeep.status).toBe(502);
  });

  it('mantém interoperabilidade de rsig entre Node e Worker e rejeita Referer adulterado ou sem assinatura', async () => {
    const target = 'https://cdn-s01.mywallpaper-4k-image.net/stream/ep21/seg-001.webp';
    const exp = 2_000_000_000;
    const now = 1_795_000_000;
    const referer = 'https://api.anivideo.net/';

    const nodeRsig = createProxyRefererSignature(target, exp, referer);
    const workerRsig = await createWorkerRefererSignature(target, exp, referer, TEST_SECRET);
    expect(workerRsig).toBe(nodeRsig);

    expect(
      await verifyWorkerProxyReferer(target, String(exp), referer, nodeRsig, TEST_SECRET, now)
    ).toEqual({ valid: true, referer });

    // Adulterado / sem rsig / expirado / protocolo inválido
    expect(
      await verifyWorkerProxyReferer(target, String(exp), 'https://evil.example/', workerRsig, TEST_SECRET, now)
    ).toEqual({ valid: false, referer: null });
    expect(
      await verifyWorkerProxyReferer(target, String(exp), referer, null, TEST_SECRET, now)
    ).toEqual({ valid: false, referer: null });
    expect(
      await verifyWorkerProxyReferer(target, String(exp), referer, workerRsig, TEST_SECRET, exp + 10)
    ).toEqual({ valid: false, referer: null });

    const sig = await createWorkerProxySignature(target, exp, TEST_SECRET);
    const fetcher = vi.fn();
    const tamperedReq = new Request(
      `https://hikari-media-proxy.workers.dev/api/proxy/stream?url=${encodeURIComponent(target)}&exp=${exp}&sig=${sig}&ref=${encodeURIComponent('https://evil.example/')}&rsig=${encodeURIComponent(workerRsig)}`
    );
    const resTampered = await handleWorkerProxyRequest(tamperedReq, env, undefined, {
      fetcher,
      edgeCache: null,
      nowSeconds: () => now,
    });
    expect(resTampered.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('propaga no Worker o Referer vencedor após fallback 403 para variante, segmentos, EXT-X-KEY e EXT-X-MAP e preserva comportamento padrão sem fallback', async () => {
    const masterUrl = 'https://cdn-s01.mywallpaper-4k-image.net/redirect/master.m3u8';
    const redirectedMasterUrl = 'https://edge02.mywallpaper-4k-image.net/hls/ep21/master.m3u8';
    const variantUrl = 'https://edge02.mywallpaper-4k-image.net/hls/ep21/720p/index.m3u8';
    const keyUrl = 'https://edge02.mywallpaper-4k-image.net/hls/ep21/720p/keys/enc.key';
    const mapUrl = 'https://edge02.mywallpaper-4k-image.net/hls/ep21/720p/init.mp4';
    const relSegUrl = 'https://edge02.mywallpaper-4k-image.net/hls/ep21/720p/seg-001.webp';
    const absSegUrl = 'https://cdn-backup.outrohost.net/chunks/seg-002.ts?tok=xyz';

    const workerEnv: WorkerEnv = {
      PLAYER_SESSION_SECRET: TEST_SECRET,
    };
    const seenReferersByUrl = new Map<string, Array<string | null>>();

    const fetcher = vi.fn(async (input: string, init?: CfRequestInit) => {
      const ref = new Headers(init?.headers).get('referer');
      const arr = seenReferersByUrl.get(input) ?? [];
      arr.push(ref);
      seenReferersByUrl.set(input, arr);

      if (ref !== 'https://api.anivideo.net/') {
        return new Response('Forbidden', { status: 403 });
      }

      if (input === masterUrl) {
        return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\n720p/index.m3u8', {
          status: 302,
          headers: { location: redirectedMasterUrl },
        });
      }
      if (input === redirectedMasterUrl) {
        return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\n720p/index.m3u8', {
          status: 200,
          headers: { 'content-type': 'application/vnd.apple.mpegurl' },
        });
      }
      if (input === variantUrl) {
        return new Response(
          [
            '#EXTM3U',
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
        );
      }
      if (input === keyUrl || input === mapUrl) {
        return new Response(new Uint8Array([0x01, 0x02, 0x03]), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      }
      return new Response(new Uint8Array([0x47, 0x40, 0x00, 0x10]), {
        status: 200,
        headers: { 'content-type': 'image/webp' },
      });
    });

    const exp = 2_000_000_000;
    const now = 1_795_000_000;
    const masterSig = await createWorkerProxySignature(masterUrl, exp, TEST_SECRET);
    const resMaster = await handleWorkerProxyRequest(
      new Request(
        `https://hikari-media-proxy.workers.dev/api/proxy/stream?url=${encodeURIComponent(masterUrl)}&exp=${exp}&sig=${masterSig}`
      ),
      workerEnv,
      undefined,
      { fetcher, edgeCache: null, nowSeconds: () => now }
    );

    expect(resMaster.status).toBe(200);
    expect(seenReferersByUrl.get(masterUrl)).toEqual([
      'https://www.anitube.biz/',
      'https://api.anivideo.net/',
    ]);

    const masterBody = await resMaster.text();
    const variantPath = masterBody.split('\n').find((l) => l.includes(encodeURIComponent(variantUrl)))!.trim();
    const variantParsed = new URL(`https://hikari-media-proxy.workers.dev${variantPath}`);
    expect(variantParsed.searchParams.get('ref')).toBe('https://api.anivideo.net/');
    expect(variantParsed.searchParams.get('rsig')).toBeTruthy();

    const resVariant = await handleWorkerProxyRequest(new Request(variantParsed.toString()), workerEnv, undefined, {
      fetcher,
      edgeCache: null,
      nowSeconds: () => now,
    });
    expect(resVariant.status).toBe(200);
    expect(seenReferersByUrl.get(variantUrl)).toEqual(['https://api.anivideo.net/']);

    const variantBody = await resVariant.text();
    const childUrls = (variantBody.match(/\/api\/proxy\/stream\?[^\s"']+/g) ?? []).map(
      (p) => new URL(`https://hikari-media-proxy.workers.dev${p}`)
    );

    for (const target of [keyUrl, mapUrl, relSegUrl, absSegUrl]) {
      const child = childUrls.find((u) => u.searchParams.get('url') === target);
      expect(child, `URL filha ausente no Worker: ${target}`).toBeDefined();
      expect(child!.searchParams.get('ref')).toBe('https://api.anivideo.net/');
      expect(child!.searchParams.get('rsig')).toBeTruthy();

      const childRes = await handleWorkerProxyRequest(new Request(child!.toString()), workerEnv, undefined, {
        fetcher,
        edgeCache: null,
        nowSeconds: () => now,
      });
      expect(childRes.status).toBe(200);
      expect(seenReferersByUrl.get(target)).toEqual(['https://api.anivideo.net/']);
    }

    // Sem necessidade de fallback (200 de primeira): não adiciona ref/rsig
    const stdUrl = 'https://cdn-sv01.maximaimg.online/stream/b/bakemonogatari/01.mp4/index.m3u8';
    const stdSig = await createWorkerProxySignature(stdUrl, exp, TEST_SECRET);
    const stdFetcher = vi.fn(async () =>
      new Response('#EXTM3U\n#EXTINF:6.0,\nseg-001.ts\n#EXT-X-ENDLIST', {
        status: 200,
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      })
    );
    const stdRes = await handleWorkerProxyRequest(
      new Request(
        `https://hikari-media-proxy.workers.dev/api/proxy/stream?url=${encodeURIComponent(stdUrl)}&exp=${exp}&sig=${stdSig}`
      ),
      workerEnv,
      undefined,
      { fetcher: stdFetcher, edgeCache: null, nowSeconds: () => now }
    );
    expect(stdRes.status).toBe(200);
    const stdBody = await stdRes.text();
    const stdChild = new URL(
      `https://hikari-media-proxy.workers.dev${stdBody.split('\n').find((l) => l.includes('seg-001.ts'))!.trim()}`
    );
    expect(stdChild.searchParams.has('ref')).toBe(false);
    expect(stdChild.searchParams.has('rsig')).toBe(false);
  });
});
