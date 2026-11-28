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
    expect(resHome.headers.get('Cache-Control')).toBe(
      'public, s-maxage=300, stale-while-revalidate=900'
    );
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
