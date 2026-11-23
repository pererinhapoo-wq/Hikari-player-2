import { describe, expect, it } from 'vitest';
import {
  buildBaseHref,
  EMBED_CHROME_UA,
  handleEmbedRequest,
  injectBaseTag,
  MAX_EMBED_BODY_BYTES,
  resolveEmbedProxy,
} from '@/lib/embed-proxy';
import { diagnoseVideoSource } from '@/lib/source-diagnostics';
import {
  buildIframePlayUrl,
  buildIframeSrcWithFreshTime,
  collectEpisodeSources,
  EMBED_ALLOWED_FINAL_HOSTS,
  EMBED_DIRECT_HOSTS,
  EMBED_NO_REFERRER_HOSTS,
  EMBED_PROXIED_HOSTS,
  getIframeReferrerPolicy,
  normalizeVideoSource,
} from '@/lib/video-sources';

const passSafeUrl = async (raw: string) => new URL(raw);

function getHeaderCaseInsensitive(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (Array.isArray(headers)) {
    const found = headers.find(([k]) => k.toLowerCase() === name.toLowerCase());
    return found?.[1];
  }
  const entry = Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

describe('Part A: allowlists separadas, buildIframePlayUrl e prioridade de fontes', () => {
  it('define EMBED_PROXIED_HOSTS, EMBED_ALLOWED_FINAL_HOSTS e EMBED_DIRECT_HOSTS conforme especificação', () => {
    expect([...EMBED_PROXIED_HOSTS]).toEqual(['allappinc.com']);
    expect([...EMBED_ALLOWED_FINAL_HOSTS]).toEqual([
      'allappinc.com',
      'api.anivideo.net',
      'cdn-sv01.maximaimg.online',
      'cdn-s01.mywallpaper-4k-image.net',
      'anitube.biz',
      'anitube22.vip',
      'anitube.zip',
      'anitube.ninja',
      'animesdigital.org',
    ]);
    expect([...EMBED_DIRECT_HOSTS]).toEqual([
      'anitube22.vip',
      'anitube.biz',
      'anitube.zip',
      'anitube.ninja',
      'animesdigital.org',
      'filevideo1.com',
    ]);
    expect([...EMBED_NO_REFERRER_HOSTS]).toEqual(['filevideo1.com']);
  });

  it('monta URL direta para EMBED_DIRECT_HOSTS/outros e /api/embed?u=... para EMBED_PROXIED_HOSTS', () => {
    const anitubeUrl = 'https://anitube22.vip/playerricas.php?id=123&time=1000';
    expect(buildIframePlayUrl(anitubeUrl)).toBe(anitubeUrl);
    expect(buildIframePlayUrl('https://animesdigital.org/embed/abc')).toBe(
      'https://animesdigital.org/embed/abc'
    );
    const filevideoUrl =
      'https://filevideo1.com/remote_control.php?time=1700000000&cv=abc&cv2=def&file=ep01.mp4';
    expect(buildIframePlayUrl(filevideoUrl)).toBe(filevideoUrl);
    expect(buildIframePlayUrl('https://outro-host.example/embed/1')).toBe(
      'https://outro-host.example/embed/1'
    );

    const allappUrl = 'https://allappinc.com/embed/ep-1?v=2';
    expect(buildIframePlayUrl(allappUrl)).toBe(
      `/api/embed?u=${encodeURIComponent(allappUrl)}`
    );
  });

  it('aplica referrerPolicy no-referrer apenas para EMBED_NO_REFERRER_HOSTS e mantém no-referrer-when-downgrade nos demais', () => {
    expect(
      getIframeReferrerPolicy('https://filevideo1.com/remote_control.php?file=ep01.mp4')
    ).toBe('no-referrer');
    expect(
      getIframeReferrerPolicy('https://cdn.filevideo1.com/remote_control.php?file=ep01.mp4')
    ).toBe('no-referrer');
    expect(
      getIframeReferrerPolicy('https://anitube22.vip/playerricas.php?id=123&time=1000')
    ).toBe('no-referrer-when-downgrade');
    expect(
      getIframeReferrerPolicy(`/api/embed?u=${encodeURIComponent('https://allappinc.com/embed/1')}`)
    ).toBe('no-referrer-when-downgrade');
  });

  it('renova parâmetro time tanto em URL direta quanto dentro de /api/embed?u=..., mas preserva link literal com parâmetros cv*', () => {
    const direct = 'https://anitube22.vip/playerricas.php?id=42&time=111';
    expect(buildIframeSrcWithFreshTime(direct, 9999)).toBe(
      'https://anitube22.vip/playerricas.php?id=42&time=9999'
    );

    const wrapped = buildIframePlayUrl('https://allappinc.com/embed/42?time=111');
    expect(buildIframeSrcWithFreshTime(wrapped, 9999)).toBe(
      `/api/embed?u=${encodeURIComponent('https://allappinc.com/embed/42?time=9999')}`
    );

    const filevideoHashed =
      'https://filevideo1.com/remote_control.php?time=111&cv=h1&cv2=h2&cv3=h3&cv4=h4&file=ep01.mp4';
    expect(buildIframeSrcWithFreshTime(filevideoHashed, 9999)).toBe(filevideoHashed);
  });

  it('prioriza fontes playerricas acima de fontes allappinc em collectEpisodeSources', () => {
    const sources = collectEpisodeSources({
      video_url: 'https://allappinc.com/embed/ep01',
      video_url_2: 'https://anitube22.vip/playerricas.php?id=ep01',
      video_url_3: 'https://cdn.example.com/ep01.m3u8',
    });

    expect(sources.map((s) => s.slot)).toEqual([2, 3, 1]);
    expect(sources[0].resolvedUrl).toContain('playerricas.php');
    expect(sources[2].resolvedUrl).toContain('allappinc.com');
  });

  it('mantém HLS/MP4 inalterados mesmo quando não são iframe', () => {
    const hls = normalizeVideoSource('https://cdn.example.com/master.m3u8', 1);
    expect(hls?.kind).toBe('hls');
    expect(hls?.needsProxy).toBe(true);
  });
});

describe('Part B: /api/embed, redirecionamentos validados, Referer da entrada e fallback 403', () => {
  it('recusa protocolo não-HTTPS e hosts de entrada fora de EMBED_PROXIED_HOSTS (inclusive hosts finais como api.anivideo.net)', async () => {
    const httpReq = new Request(
      `https://app.test/api/embed?u=${encodeURIComponent('http://allappinc.com/embed/1')}`
    );
    expect((await handleEmbedRequest(httpReq)).status).toBe(400);

    const anivideoEntry = new Request(
      `https://app.test/api/embed?u=${encodeURIComponent('https://api.anivideo.net/play?id=1')}`
    );
    expect((await handleEmbedRequest(anivideoEntry)).status).toBe(403);

    const anitubeEntry = new Request(
      `https://app.test/api/embed?u=${encodeURIComponent('https://anitube22.vip/playerricas.php')}`
    );
    expect((await handleEmbedRequest(anitubeEntry)).status).toBe(403);

    const evilEntry = new Request(
      `https://app.test/api/embed?u=${encodeURIComponent('https://evil.example.com/embed/1')}`
    );
    expect((await handleEmbedRequest(evilEntry)).status).toBe(403);
  });

  it('segue até 3 saltos dentro de EMBED_ALLOWED_FINAL_HOSTS enviando Referer sempre da URL de entrada, sem Origin, e remove Set-Cookie/CSP/XFO', async () => {
    const fetchedCalls: Array<{ url: string; referer?: string; origin?: string; ua?: string }> = [];
    const req = new Request(
      `https://app.test/api/embed?u=${encodeURIComponent('https://allappinc.com/watch/ep01')}`,
      { headers: { Origin: 'https://meuplayer.vercel.app' } }
    );

    const result = await resolveEmbedProxy(req, {
      assertSafeUrl: passSafeUrl,
      fetchImpl: async (input, init) => {
        const url = String(input);
        fetchedCalls.push({
          url,
          referer: getHeaderCaseInsensitive(init?.headers, 'Referer'),
          origin: getHeaderCaseInsensitive(init?.headers, 'Origin'),
          ua: getHeaderCaseInsensitive(init?.headers, 'User-Agent'),
        });

        if (url === 'https://allappinc.com/watch/ep01') {
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://api.anivideo.net/redirect/ep01' },
          });
        }
        if (url === 'https://api.anivideo.net/redirect/ep01') {
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://cdn-sv01.maximaimg.online/hop2/ep01' },
          });
        }
        if (url === 'https://cdn-sv01.maximaimg.online/hop2/ep01') {
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://anitube22.vip/player/ep01/view' },
          });
        }

        return new Response(
          '<!doctype html><html><head><script src="rel.js"></script></head><body>Player $1 $& OK</body></html>',
          {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=ISO-8859-1',
              'Content-Security-Policy': "frame-ancestors 'self';",
              'X-Frame-Options': 'SAMEORIGIN',
              'Set-Cookie': 'session=secret; HttpOnly; Path=/',
              'Content-Encoding': 'gzip',
              'Content-Length': '9999',
              Connection: 'keep-alive, x-hop-custom',
              'Keep-Alive': 'timeout=5',
              'Transfer-Encoding': 'chunked',
              'x-hop-custom': 'drop',
            },
          }
        );
      },
    });

    expect(fetchedCalls).toHaveLength(4);
    for (const call of fetchedCalls) {
      expect(call.ua).toBe(EMBED_CHROME_UA);
      expect(call.referer).toBe('https://allappinc.com/');
      expect(call.origin).toBeUndefined();
    }

    const res = result.response;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe(
      'public, s-maxage=300, stale-while-revalidate=900'
    );
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('x-frame-options')).toBeNull();
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.headers.get('transfer-encoding')).toBeNull();
    expect(res.headers.get('connection')).toBeNull();
    expect(res.headers.get('x-hop-custom')).toBeNull();

    const body = await res.text();
    expect(body).toContain('<head><base href="https://anitube22.vip/player/ep01/">');
    expect(body).toContain('<script src="rel.js"></script>');
    expect(body).toContain('Player $1 $& OK');

    expect(result.successfulStrategy).toBe('chrome_ua_with_referer');
    expect(result.finalUrl).toBe('https://anitube22.vip/player/ep01/view');
    expect(result.redirectChain.map((h) => `${h.host}:${h.status}`)).toEqual([
      'allappinc.com:302',
      'api.anivideo.net:302',
      'cdn-sv01.maximaimg.online:302',
      'anitube22.vip:200',
    ]);
  });

  it('retorna 403 se qualquer salto (intermediário ou final) sair de EMBED_ALLOWED_FINAL_HOSTS', async () => {
    const fetchedUrls: string[] = [];
    const req = new Request(
      `https://app.test/api/embed?u=${encodeURIComponent('https://allappinc.com/embed/1')}`
    );

    const result = await resolveEmbedProxy(req, {
      assertSafeUrl: passSafeUrl,
      fetchImpl: async (input) => {
        const url = String(input);
        fetchedUrls.push(url);
        if (url === 'https://allappinc.com/embed/1') {
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://api.anivideo.net/step1' },
          });
        }
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://evil-outside.com/phish' },
        });
      },
    });

    expect(result.response.status).toBe(403);
    expect(fetchedUrls).not.toContain('https://evil-outside.com/phish');
    expect(await result.response.text()).toContain('evil-outside.com');
  });

  it('retorna 502 se houver mais de 3 saltos de redirecionamento', async () => {
    const req = new Request(
      `https://app.test/api/embed?u=${encodeURIComponent('https://allappinc.com/hop0')}`
    );

    let hopCounter = 0;
    const result = await resolveEmbedProxy(req, {
      assertSafeUrl: passSafeUrl,
      fetchImpl: async () => {
        hopCounter += 1;
        return new Response(null, {
          status: 302,
          headers: { Location: `https://api.anivideo.net/hop${hopCounter}` },
        });
      },
    });

    expect(result.response.status).toBe(502);
    expect(hopCounter).toBe(4);
    expect(await result.response.text()).toContain('3');
  });

  it('em resposta 403 do destino, tenta uma vez mais só com Chrome UA sem Referer', async () => {
    const calls: Array<{ url: string; referer?: string; ua?: string }> = [];
    const req = new Request(
      `https://app.test/api/embed?u=${encodeURIComponent('https://allappinc.com/e/123')}`
    );

    const result = await resolveEmbedProxy(req, {
      assertSafeUrl: passSafeUrl,
      fetchImpl: async (input, init) => {
        const url = String(input);
        const referer = getHeaderCaseInsensitive(init?.headers, 'Referer');
        const ua = getHeaderCaseInsensitive(init?.headers, 'User-Agent');
        calls.push({ url, referer, ua });

        if (url === 'https://allappinc.com/e/123') {
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://api.anivideo.net/video/123' },
          });
        }

        if (url === 'https://api.anivideo.net/video/123' && referer) {
          return new Response('Forbidden with Referer', { status: 403 });
        }

        return new Response('<html><head></head><body>OK sem Referer</body></html>', {
          status: 200,
          headers: { 'Set-Cookie': 'ignore=1' },
        });
      },
    });

    expect(calls).toEqual([
      { url: 'https://allappinc.com/e/123', referer: 'https://allappinc.com/', ua: EMBED_CHROME_UA },
      { url: 'https://api.anivideo.net/video/123', referer: 'https://allappinc.com/', ua: EMBED_CHROME_UA },
      { url: 'https://api.anivideo.net/video/123', referer: undefined, ua: EMBED_CHROME_UA },
    ]);

    expect(result.response.status).toBe(200);
    expect(result.response.headers.get('set-cookie')).toBeNull();
    expect(result.successfulStrategy).toBe('chrome_ua_no_referer');
    expect(await result.response.text()).toContain(
      '<head><base href="https://api.anivideo.net/video/">'
    );
    expect(result.redirectChain.map((h) => `${h.host}:${h.status}:${h.authMode}`)).toEqual([
      'allappinc.com:302:chrome_ua_with_referer',
      'api.anivideo.net:403:chrome_ua_with_referer',
      'api.anivideo.net:200:chrome_ua_no_referer',
    ]);
  });

  it('retorna 502 se fallback sem Referer após 403 também responder 403', async () => {
    const req = new Request(
      `https://app.test/api/embed?u=${encodeURIComponent('https://allappinc.com/e/locked')}`
    );

    const result = await resolveEmbedProxy(req, {
      assertSafeUrl: passSafeUrl,
      fetchImpl: async () => new Response('Forbidden', { status: 403 }),
    });

    expect(result.response.status).toBe(502);
    expect(result.successfulStrategy).toBeNull();
    expect(await result.response.text()).toContain('403');
  });

  it('calcula base href e prefixa <base> quando não houver <head>', () => {
    expect(buildBaseHref(new URL('https://allappinc.com/embed/123'))).toBe(
      'https://allappinc.com/embed/'
    );
    expect(buildBaseHref(new URL('https://allappinc.com/embed/123/'))).toBe(
      'https://allappinc.com/embed/123/'
    );
    expect(buildBaseHref(new URL('https://allappinc.com'))).toBe(
      'https://allappinc.com/'
    );
    expect(injectBaseTag('<div>sem head</div>', 'https://allappinc.com/embed/')).toBe(
      '<base href="https://allappinc.com/embed/"><div>sem head</div>'
    );
  });

  it('recusa corpo acima de 1 MB tanto por Content-Length quanto por stream', async () => {
    const req = new Request(
      `https://app.test/api/embed?u=${encodeURIComponent('https://allappinc.com/embed/big')}`
    );

    const byHeader = await handleEmbedRequest(req, {
      assertSafeUrl: passSafeUrl,
      fetchImpl: async () =>
        new Response('ok', {
          status: 200,
          headers: { 'Content-Length': String(MAX_EMBED_BODY_BYTES + 1) },
        }),
    });
    expect(byHeader.status).toBe(413);

    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600_000).fill(65));
        controller.enqueue(new Uint8Array(600_000).fill(66));
        controller.close();
      },
    });
    const byStream = await handleEmbedRequest(req, {
      assertSafeUrl: passSafeUrl,
      fetchImpl: async () => new Response(oversizedStream, { status: 200 }),
    });
    expect(byStream.status).toBe(413);
    expect(await byStream.text()).toContain('1 MB');
  });
});

describe('Part C: diagnóstico "Testar fonte" com cadeia de saltos e estratégia vencedora', () => {
  it('reporta cadeia completa de saltos e fallback sem Referer para allappinc.com', async () => {
    const embedFetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const referer = getHeaderCaseInsensitive(init?.headers, 'Referer');
      if (url === 'https://allappinc.com/embed/ep-demo') {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://api.anivideo.net/play/ep-demo' },
        });
      }
      if (url === 'https://api.anivideo.net/play/ep-demo' && referer) {
        return new Response('Forbidden', { status: 403 });
      }
      return new Response('<html><head></head><body>ok</body></html>', { status: 200 });
    };

    const report = await diagnoseVideoSource(
      {
        slot: 1,
        url: 'https://allappinc.com/embed/ep-demo',
      },
      {
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response('<html><head></head><body>blocked iframe</body></html>', {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Content-Security-Policy': "frame-ancestors 'self' https://trusted.example",
            },
          }),
        }),
        embedAssertSafeUrl: passSafeUrl,
        embedFetchImpl,
      }
    );

    expect(report.detectedKind).toBe('iframe');
    expect(report.verdict).toBe('proxy_necessario');
    expect(report.embedDiagnostic).toEqual({
      hostCategory: 'proxied',
      hostLabel: 'Exige /api/embed',
      directStatus: 200,
      hasFrameAncestors: true,
      frameAncestorsValue: "frame-ancestors 'self' https://trusted.example",
      embedProxyStatus: 200,
      embedProxyOk: true,
      embedProxyError: null,
      successfulStrategy: 'chrome_ua_no_referer',
      finalUrl: 'https://api.anivideo.net/play/ep-demo',
      redirectChain: [
        {
          host: 'allappinc.com',
          url: 'https://allappinc.com/embed/ep-demo',
          status: 302,
          location: 'https://api.anivideo.net/play/ep-demo',
          authMode: 'chrome_ua_with_referer',
          error: null,
        },
        {
          host: 'api.anivideo.net',
          url: 'https://api.anivideo.net/play/ep-demo',
          status: 403,
          location: null,
          authMode: 'chrome_ua_with_referer',
          error: null,
        },
        {
          host: 'api.anivideo.net',
          url: 'https://api.anivideo.net/play/ep-demo',
          status: 200,
          location: null,
          authMode: 'chrome_ua_no_referer',
          error: null,
        },
      ],
    });
  });

  it('reporta iframe direto sem /api/embed para anitube22.vip/playerricas.php', async () => {
    const report = await diagnoseVideoSource(
      {
        slot: 1,
        url: 'https://anitube22.vip/playerricas.php?id=123',
      },
      {
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response('<html><body>playerricas ok</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          }),
        }),
      }
    );

    expect(report.detectedKind).toBe('iframe');
    expect(report.verdict).toBe('direto_ok');
    expect(report.embedDiagnostic).toEqual({
      hostCategory: 'direct',
      hostLabel: 'Iframe direto (sem /api/embed)',
      directStatus: 200,
      hasFrameAncestors: false,
      frameAncestorsValue: null,
      embedProxyStatus: null,
      embedProxyOk: false,
      embedProxyError: null,
      redirectChain: [],
      successfulStrategy: null,
      finalUrl: null,
    });
  });
});
