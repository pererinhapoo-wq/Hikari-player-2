import { createMemoryHistory } from '@tanstack/react-router';
import {
  attachRouterServerSsrUtils,
  defaultStreamHandler,
} from '@tanstack/react-router/ssr/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCurrentCspNonce } from '@/lib/csp-nonce';
import { EMBED_SANDBOX_CSP, handleEmbedRequest } from '@/lib/embed-proxy';
import { buildSignedProxyPath } from '@/lib/proxy-signing';
import {
  applySecurityHeaders,
  buildDocumentCsp,
  generateCspNonce,
  isHttpsRequest,
  runWithCspNonce,
  SECURITY_HEADER_VALUES,
  shouldGenerateDocumentNonce,
} from '@/lib/security-headers';
import { handleProxyStreamRequest } from '@/lib/stream-proxy';
import { getRouter } from '@/router';
import { Route as AdminRoute } from '@/routes/admin';
import { Route as EpisodeRoute } from '@/routes/e/$id';
import { Route as HomeRoute } from '@/routes/index';

describe('ALTO-01 — HTTP Security Headers e CSP', () => {
  const originalSecret = process.env.PLAYER_SESSION_SECRET;
  const originalWorkerBase = process.env.WORKER_BASE;

  beforeEach(() => {
    process.env.PLAYER_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
    delete process.env.WORKER_BASE;
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.PLAYER_SESSION_SECRET;
    } else {
      process.env.PLAYER_SESSION_SECRET = originalSecret;
    }
    if (originalWorkerBase === undefined) {
      delete process.env.WORKER_BASE;
    } else {
      process.env.WORKER_BASE = originalWorkerBase;
    }
  });

  it('1. páginas públicas (/ e /e/$id) recebem os headers gerais de segurança', () => {
    const reqHome = new Request('https://hikariplayer.cc.cd/');
    const resHome = applySecurityHeaders(
      reqHome,
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900',
        },
      }),
      { nonce: 'noncePublic123==', nodeEnv: 'production' }
    );

    expect(resHome.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(resHome.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(resHome.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(resHome.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    expect(resHome.headers.get('Cache-Control')).toBe('private, no-store');
    expect(resHome.headers.get('CDN-Cache-Control')).toBe('private, no-store');
    expect(resHome.headers.get('Content-Security-Policy')).toContain("'nonce-noncePublic123=='");

    const reqEp = new Request('https://hikariplayer.cc.cd/e/ep_01');
    const resEp = applySecurityHeaders(
      reqEp,
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
      { nonce: 'nonceEp456==', nodeEnv: 'production' }
    );
    expect(resEp.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(resEp.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(resEp.headers.get('Content-Security-Policy')).toContain("'nonce-nonceEp456=='");
  });

  it('2. página administrativa (/admin) recebe headers gerais preservando Cache-Control private no-store', () => {
    const reqAdmin = new Request('https://hikariplayer.cc.cd/admin');
    const resAdmin = applySecurityHeaders(
      reqAdmin,
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'private, no-store',
          'CDN-Cache-Control': 'private, no-store',
          Vary: 'Cookie',
        },
      }),
      { nonce: 'nonceAdmin789==', nodeEnv: 'production' }
    );

    expect(resAdmin.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(resAdmin.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(resAdmin.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(resAdmin.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    expect(resAdmin.headers.get('Cache-Control')).toBe('private, no-store');
    expect(resAdmin.headers.get('Vary')).toBe('Cookie');
    expect(resAdmin.headers.get('Content-Security-Policy')).toContain("'nonce-nonceAdmin789=='");
  });

  it('3. respostas de erro (404 HTML, 500 HTML e erros JSON de API) mantêm os headers aplicáveis', () => {
    const res404 = applySecurityHeaders(
      new Request('https://hikariplayer.cc.cd/nao-existe'),
      new Response('<!doctype html><html><body>Not found</body></html>', {
        status: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
      { nonce: 'nonce404==', nodeEnv: 'production' }
    );
    expect(res404.status).toBe(404);
    expect(res404.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res404.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(res404.headers.get('Content-Security-Policy')).toContain("object-src 'none'");

    const res500 = applySecurityHeaders(
      new Request('https://hikariplayer.cc.cd/e/ep_fail'),
      new Response('Internal Server Error', {
        status: 500,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
      { nonce: 'nonce500==', nodeEnv: 'production' }
    );
    expect(res500.status).toBe(500);
    expect(res500.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res500.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');

    const resApiErr = applySecurityHeaders(
      new Request('https://hikariplayer.cc.cd/api/mirror', { method: 'POST' }),
      Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 }),
      { nodeEnv: 'production' }
    );
    expect(resApiErr.status).toBe(401);
    expect(resApiErr.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(resApiErr.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(resApiErr.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
  });

  it('4. /api/embed preserva exatamente sua CSP sandbox, Referrer-Policy no-referrer e X-Frame-Options SAMEORIGIN', async () => {
    const embedReq = new Request(
      'https://hikariplayer.cc.cd/api/embed?u=' +
        encodeURIComponent('https://allappinc.com/embed/fake123')
    );
    const rawEmbedRes = await handleEmbedRequest(embedReq, {
      assertSafeUrl: async (raw) => new URL(raw),
      fetchImpl: async () =>
        new Response('<html><head></head><body><video></video></body></html>', {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': 'default-src *',
            'X-Frame-Options': 'ALLOWALL',
          },
        }),
    });

    const securedEmbedRes = applySecurityHeaders(embedReq, rawEmbedRes, {
      nonce: 'ignoredNonce',
      nodeEnv: 'production',
    });

    expect(securedEmbedRes.status).toBe(200);
    expect(securedEmbedRes.headers.get('Content-Security-Policy')).toBe(EMBED_SANDBOX_CSP);
    expect(securedEmbedRes.headers.get('Content-Security-Policy')).not.toContain('allow-same-origin');
    expect(securedEmbedRes.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(securedEmbedRes.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(securedEmbedRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(securedEmbedRes.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');

    const errorEmbedRes = applySecurityHeaders(
      new Request('https://hikariplayer.cc.cd/api/embed'),
      await handleEmbedRequest(new Request('https://hikariplayer.cc.cd/api/embed')),
      { nodeEnv: 'production' }
    );
    expect(errorEmbedRes.status).toBe(400);
    expect(errorEmbedRes.headers.get('Content-Security-Policy')).toBe(EMBED_SANDBOX_CSP);
    expect(errorEmbedRes.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('5. /api/proxy/stream preserva headers de streaming HLS/binário sem X-Frame-Options DENY, COEP ou CORP restritivo', async () => {
    const upstreamManifestUrl = 'https://cdn-sv01.maximaimg.online/stream/ep01/master.m3u8';
    const signedPath = buildSignedProxyPath(upstreamManifestUrl);
    const proxyReq = new Request(`https://hikariplayer.cc.cd${signedPath}`);

    const rawManifestRes = await handleProxyStreamRequest(proxyReq, {
      fetchWithRedirects: async () => ({
        finalUrl: upstreamManifestUrl,
        response: new Response('#EXTM3U\n#EXTINF:6.0,\nseg01.ts\n', {
          status: 200,
          headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
        }),
      }),
    });

    const securedManifestRes = applySecurityHeaders(proxyReq, rawManifestRes, {
      nodeEnv: 'production',
    });

    expect(securedManifestRes.status).toBe(200);
    expect(securedManifestRes.headers.get('Content-Type')).toBe(
      'application/vnd.apple.mpegurl; charset=utf-8'
    );
    expect(securedManifestRes.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(securedManifestRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(securedManifestRes.headers.get('X-Frame-Options')).toBeNull();
    expect(securedManifestRes.headers.get('Content-Security-Policy')).toBeNull();
    expect(securedManifestRes.headers.get('Cross-Origin-Embedder-Policy')).toBeNull();
    expect(securedManifestRes.headers.get('Cross-Origin-Resource-Policy')).toBeNull();
    const manifestText = await securedManifestRes.text();
    expect(manifestText).toContain('/api/proxy/stream?');
  });

  it('6. respostas 206 Partial Content em /api/proxy/stream continuam funcionando integralmente', async () => {
    const upstreamMp4Url = 'https://cdn-media.example.test/anime/ep01.mp4';
    const signedPath = buildSignedProxyPath(upstreamMp4Url);
    const rangeReq = new Request(`https://hikariplayer.cc.cd${signedPath}`, {
      headers: { Range: 'bytes=0-1023' },
    });

    const payloadBytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    const raw206 = await handleProxyStreamRequest(rangeReq, {
      fetchWithRedirects: async () => ({
        finalUrl: upstreamMp4Url,
        response: new Response(payloadBytes, {
          status: 206,
          headers: {
            'Content-Type': 'video/mp4',
            'Content-Length': '8',
            'Content-Range': 'bytes 0-7/1048576',
            'Accept-Ranges': 'bytes',
          },
        }),
      }),
    });

    const secured206 = applySecurityHeaders(rangeReq, raw206, { nodeEnv: 'production' });
    expect(secured206.status).toBe(206);
    expect(secured206.headers.get('Content-Type')).toBe('video/mp4');
    expect(secured206.headers.get('Content-Length')).toBe('8');
    expect(secured206.headers.get('Content-Range')).toBe('bytes 0-7/1048576');
    expect(secured206.headers.get('Accept-Ranges')).toBe('bytes');
    expect(secured206.headers.get('Access-Control-Expose-Headers')).toContain('Content-Range');
    expect(secured206.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(secured206.headers.get('X-Frame-Options')).toBeNull();
    const received = new Uint8Array(await secured206.arrayBuffer());
    expect(Array.from(received)).toEqual(Array.from(payloadBytes));
  });

  it('7. nenhum header duplicado ou contraditório é enviado', () => {
    const req = new Request('https://hikariplayer.cc.cd/e/ep_01');
    const preExisting = new Response('<!doctype html><html></html>', {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    });
    const res = applySecurityHeaders(req, preExisting, {
      nonce: 'abc123==',
      nodeEnv: 'production',
    });

    const keys = Array.from(res.headers.keys()).map((k) => k.toLowerCase());
    const uniqueKeys = new Set(keys);
    expect(keys.length).toBe(uniqueKeys.size);
    expect(res.headers.get('X-Frame-Options')).not.toBe('DENY');

    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).not.toContain('unsafe-eval');
    const scriptDirective = csp
      .split(';')
      .map((s) => s.trim())
      .find((d) => d.startsWith('script-src'));
    expect(scriptDirective).toBe("script-src 'self' 'nonce-abc123=='");
    expect(scriptDirective).not.toContain('unsafe-inline');
  });

  it('8. a CSP permite recursos locais essenciais, Google Fonts, HLS.js workers (blob:) e WORKER_BASE configurado', () => {
    const csp = buildDocumentCsp({
      nonce: 'testNonce999==',
      workerBase: 'https://proxy-worker.hikariplayer.cc.cd/api/proxy/stream',
    });

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'nonce-testNonce999=='");
    expect(csp).toContain("style-src 'self' https://fonts.googleapis.com 'unsafe-inline'");
    expect(csp).toContain("font-src 'self' https://fonts.gstatic.com");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("media-src 'self' blob: https://proxy-worker.hikariplayer.cc.cd https:");
    expect(csp).toContain("connect-src 'self' https://proxy-worker.hikariplayer.cc.cd https:");
    expect(csp).toContain("img-src 'self' https: blob:");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");

    // Verifica propagação de nonce via AsyncLocalStorage e escopo de rota
    expect(getCurrentCspNonce()).toBeUndefined();
    const nonce = generateCspNonce();
    expect(nonce.length).toBeGreaterThanOrEqual(16);
    const observed = runWithCspNonce(nonce, () => getCurrentCspNonce());
    expect(observed).toBe(nonce);
    expect(getCurrentCspNonce()).toBeUndefined();

    expect(shouldGenerateDocumentNonce(new Request('https://hikariplayer.cc.cd/e/ep01'))).toBe(true);
    expect(
      shouldGenerateDocumentNonce(new Request('https://hikariplayer.cc.cd/api/proxy/stream'))
    ).toBe(false);
    expect(
      shouldGenerateDocumentNonce(new Request('https://hikariplayer.cc.cd/_serverFn/fn123'))
    ).toBe(false);

    // Em desenvolvimento (Vite HMR), usa Report-Only para não quebrar Fast Refresh
    const devRes = applySecurityHeaders(
      new Request('http://localhost:3000/'),
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
      { nonce, nodeEnv: 'development' }
    );
    expect(devRes.headers.get('Content-Security-Policy')).toBeNull();
    expect(devRes.headers.get('Content-Security-Policy-Report-Only')).toContain(`'nonce-${nonce}'`);
  });

  it('9. não há política global que impeça os iframes legítimos do player (/api/embed, Bunny, Mux e embeds diretos)', () => {
    const res = applySecurityHeaders(
      new Request('https://hikariplayer.cc.cd/e/ep01'),
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
      { nonce: 'frameTest==', nodeEnv: 'production' }
    );

    expect(res.headers.get('X-Frame-Options')).toBe(SECURITY_HEADER_VALUES.xFrameOptionsSameOrigin);
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("frame-src 'self' https:");
    expect(csp).toContain("frame-ancestors 'self'");
  });

  it('10. HSTS é aplicado apenas em HTTPS e nunca em HTTP', () => {
    const httpLocalReq = new Request('http://localhost:3000/');
    expect(isHttpsRequest(httpLocalReq)).toBe(false);
    const httpLocalRes = applySecurityHeaders(
      httpLocalReq,
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
      { nonce: 'n1', nodeEnv: 'production' }
    );
    expect(httpLocalRes.headers.get('Strict-Transport-Security')).toBeNull();

    const httpForwardedReq = new Request('https://hikariplayer.cc.cd/', {
      headers: { 'X-Forwarded-Proto': 'http' },
    });
    expect(isHttpsRequest(httpForwardedReq)).toBe(false);
    const httpForwardedRes = applySecurityHeaders(
      httpForwardedReq,
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
      { nonce: 'n2', nodeEnv: 'production' }
    );
    expect(httpForwardedRes.headers.get('Strict-Transport-Security')).toBeNull();

    const httpsReq = new Request('https://hikariplayer.cc.cd/');
    expect(isHttpsRequest(httpsReq)).toBe(true);
    const httpsRes = applySecurityHeaders(
      httpsReq,
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
      { nonce: 'n3', nodeEnv: 'production' }
    );
    expect(httpsRes.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    expect(httpsRes.headers.get('Strict-Transport-Security')).not.toContain('includeSubDomains');
    expect(httpsRes.headers.get('Strict-Transport-Security')).not.toContain('preload');

    const httpsForwardedReq = new Request('http://127.0.0.1:3000/', {
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    expect(isHttpsRequest(httpsForwardedReq)).toBe(true);
    const httpsForwardedRes = applySecurityHeaders(
      httpsForwardedReq,
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
      { nonce: 'n4', nodeEnv: 'production' }
    );
    expect(httpsForwardedRes.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
  });
});

describe('ALTO-01.2 — Proteção contra reutilização de CSP Nonce no cache SSR', () => {
  const originalSecret = process.env.PLAYER_SESSION_SECRET;

  beforeEach(() => {
    process.env.PLAYER_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.PLAYER_SESSION_SECRET;
    } else {
      process.env.PLAYER_SESSION_SECRET = originalSecret;
    }
  });

  it('rotas / e /e/$id declaram headers private, no-store no TanStack Router', () => {
    const homeHeaders = HomeRoute.options.headers?.({} as never);
    expect(homeHeaders).toEqual({
      'Cache-Control': 'private, no-store',
      'CDN-Cache-Control': 'private, no-store',
    });

    const episodeHeaders = EpisodeRoute.options.headers?.({} as never);
    expect(episodeHeaders).toEqual({
      'Cache-Control': 'private, no-store',
      'CDN-Cache-Control': 'private, no-store',
    });
  });

  it('1 e 2. documento HTML com nonce recebe Cache-Control e CDN-Cache-Control private, no-store', () => {
    const req = new Request('https://hikariplayer.cc.cd/e/ep_demo');
    const res = applySecurityHeaders(
      req,
      new Response('<!doctype html><html><body></body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
      { nonce: 'freshNonce01==', nodeEnv: 'production' }
    );

    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('CDN-Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Content-Security-Policy')).toContain("'nonce-freshNonce01=='");
  });

  it('3. headers anteriores de cache público são substituídos sem duplicação em HTML com nonce', () => {
    const req = new Request('https://hikariplayer.cc.cd/');
    const res = applySecurityHeaders(
      req,
      new Response('<!doctype html><html><body></body></html>', {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900',
          'CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900',
          'Content-Security-Policy': "default-src 'self'; script-src 'self' 'nonce-preserved=='",
        },
      }),
      { nonce: 'preserved==', nodeEnv: 'production' }
    );

    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('CDN-Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Cache-Control')).not.toContain('public');
    expect(res.headers.get('CDN-Cache-Control')).not.toContain('s-maxage');
    expect(res.headers.get('Content-Security-Policy')).toBe(
      "default-src 'self'; script-src 'self' 'nonce-preserved=='"
    );
  });

  it('4 e 5. duas requisições independentes geram nonces diferentes e cada HTML mantém correspondência com sua CSP', async () => {
    const renderRealSsrRequest = async (pathname: string) => {
      const url = `https://hikariplayer.cc.cd${pathname}`;
      const req = new Request(url);
      const nonce = shouldGenerateDocumentNonce(req) ? generateCspNonce() : undefined;
      expect(nonce).toBeTruthy();

      const rawResult = await runWithCspNonce(nonce, async () => {
        const router = getRouter();
        expect(router.options.ssr?.nonce).toBe(nonce);

        router.update({
          history: createMemoryHistory({ initialEntries: [pathname] }),
          origin: 'https://hikariplayer.cc.cd',
        });
        attachRouterServerSsrUtils({ router, manifest: undefined });
        await router.load();
        await router.serverSsr!.dehydrate();

        const routeHeaders = HomeRoute.options.headers?.({} as never) as Record<string, string>;
        return defaultStreamHandler({
          request: req,
          router,
          responseHeaders: new Headers({
            'content-type': 'text/html; charset=utf-8',
            ...routeHeaders,
          }),
        });
      });

      const rawRes = rawResult instanceof Response ? rawResult : rawResult.response;
      const res = applySecurityHeaders(req, rawRes, { nonce, nodeEnv: 'production' });
      const html = await res.text();
      return { nonce: nonce!, html, res };
    };

    const first = await renderRealSsrRequest('/');
    const second = await renderRealSsrRequest('/');

    expect(first.nonce).not.toBe(second.nonce);

    for (const sample of [first, second]) {
      const csp = sample.res.headers.get('Content-Security-Policy') ?? '';
      expect(csp).toContain(`'nonce-${sample.nonce}'`);
      expect(sample.res.headers.get('Cache-Control')).toBe('private, no-store');
      expect(sample.res.headers.get('CDN-Cache-Control')).toBe('private, no-store');

      const scriptOpenTags = Array.from(sample.html.matchAll(/<script\b([^>]*)>/gi)).map(
        (m) => m[1] ?? ''
      );
      expect(scriptOpenTags.length).toBeGreaterThan(0);
      for (const attrs of scriptOpenTags) {
        expect(attrs).toContain(`nonce="${sample.nonce}"`);
      }
    }

    expect(first.html).not.toContain(second.nonce);
    expect(second.html).not.toContain(first.nonce);
  });

  it('6. respostas JSON sem nonce (como /_serverFn) e assets estáticos preservam suas políticas de cache', () => {
    const serverFnReq = new Request('https://hikariplayer.cc.cd/_serverFn/getPublicEpisodeFn');
    expect(shouldGenerateDocumentNonce(serverFnReq)).toBe(false);

    const jsonRes = applySecurityHeaders(
      serverFnReq,
      Response.json(
        { status: 'ok', episode: { id: 'ep_01' } },
        {
          status: 200,
          headers: {
            'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400',
            'CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
          },
        }
      ),
      { nodeEnv: 'production' }
    );

    expect(jsonRes.headers.get('Cache-Control')).toBe(
      'public, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400'
    );
    expect(jsonRes.headers.get('CDN-Cache-Control')).toBe('public, s-maxage=60, stale-while-revalidate=300');
    expect(jsonRes.headers.get('Content-Security-Policy')).toBeNull();

    const assetReq = new Request('https://hikariplayer.cc.cd/assets/app-hash123.js');
    const assetRes = applySecurityHeaders(
      assetReq,
      new Response('console.log("ok")', {
        status: 200,
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      }),
      { nonce: 'ignoredAssetNonce==', nodeEnv: 'production' }
    );
    expect(assetRes.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(assetRes.headers.get('CDN-Cache-Control')).toBeNull();
  });

  it('7. /api/embed preserva sua CSP sandbox e cache próprios', async () => {
    const embedReq = new Request(
      'https://hikariplayer.cc.cd/api/embed?u=' +
        encodeURIComponent('https://allappinc.com/embed/demo123')
    );
    const rawEmbedRes = await handleEmbedRequest(embedReq, {
      assertSafeUrl: async (raw) => new URL(raw),
      fetchImpl: async () =>
        new Response('<html><body><video></video></body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }),
    });

    const securedEmbedRes = applySecurityHeaders(embedReq, rawEmbedRes, {
      nonce: 'shouldNotOverrideEmbed==',
      nodeEnv: 'production',
    });

    expect(securedEmbedRes.headers.get('Content-Security-Policy')).toBe(EMBED_SANDBOX_CSP);
    expect(securedEmbedRes.headers.get('Content-Security-Policy')).not.toContain('allow-same-origin');
    expect(securedEmbedRes.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(securedEmbedRes.headers.get('Cache-Control')).toBe(rawEmbedRes.headers.get('Cache-Control'));
  });

  it('8 e 9. /api/proxy/stream preserva headers de streaming, cache próprio e respostas 206', async () => {
    const upstreamMp4Url = 'https://cdn-media.example.test/anime/ep02.mp4';
    const signedPath = buildSignedProxyPath(upstreamMp4Url);
    const rangeReq = new Request(`https://hikariplayer.cc.cd${signedPath}`, {
      headers: { Range: 'bytes=0-3' },
    });

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const raw206 = await handleProxyStreamRequest(rangeReq, {
      fetchWithRedirects: async () => ({
        finalUrl: upstreamMp4Url,
        response: new Response(bytes, {
          status: 206,
          headers: {
            'Content-Type': 'video/mp4',
            'Content-Length': '4',
            'Content-Range': 'bytes 0-3/1000',
            'Accept-Ranges': 'bytes',
          },
        }),
      }),
    });

    const expectedCache = raw206.headers.get('Cache-Control');
    const expectedCdnCache = raw206.headers.get('CDN-Cache-Control');

    const secured206 = applySecurityHeaders(rangeReq, raw206, {
      nonce: 'ignoredProxyNonce==',
      nodeEnv: 'production',
    });

    expect(secured206.status).toBe(206);
    expect(secured206.headers.get('Cache-Control')).toBe(expectedCache);
    expect(secured206.headers.get('CDN-Cache-Control')).toBe(expectedCdnCache);
    expect(secured206.headers.get('Content-Range')).toBe('bytes 0-3/1000');
    expect(secured206.headers.get('Accept-Ranges')).toBe('bytes');
    expect(secured206.headers.get('Content-Security-Policy')).toBeNull();
    expect(secured206.headers.get('X-Frame-Options')).toBeNull();
  });

  it('10. /admin mantém private, no-store e Vary: Cookie', () => {
    const adminRouteHeaders = AdminRoute.options.headers?.({} as never);
    expect(adminRouteHeaders).toEqual({
      'Cache-Control': 'private, no-store',
      'CDN-Cache-Control': 'private, no-store',
      Vary: 'Cookie',
    });

    const reqAdmin = new Request('https://hikariplayer.cc.cd/admin');
    const resAdmin = applySecurityHeaders(
      reqAdmin,
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          ...(adminRouteHeaders as Record<string, string>),
        },
      }),
      { nonce: 'adminNonce01==', nodeEnv: 'production' }
    );

    expect(resAdmin.headers.get('Cache-Control')).toBe('private, no-store');
    expect(resAdmin.headers.get('CDN-Cache-Control')).toBe('private, no-store');
    expect(resAdmin.headers.get('Vary')).toBe('Cookie');
    expect(resAdmin.headers.get('Content-Security-Policy')).toContain("'nonce-adminNonce01=='");
  });
});

