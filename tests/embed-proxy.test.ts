import { describe, it, expect, vi } from 'vitest';
import {
  EMBED_PROXIED_HOSTS,
  EMBED_ALLOWED_FINAL_HOSTS,
  EMBED_DIRECT_HOSTS,
  EMBED_NO_REFERRER_HOSTS,
  buildIframePlayUrl,
  getIframeReferrerPolicy,
  buildIframeSrcWithFreshTime,
  collectEpisodeSources,
  normalizeVideoSource,
} from '@/lib/video-sources';
import { handleEmbedRequest, resolveEmbedProxy } from '@/lib/embed-proxy';
import { diagnoseVideoSource } from '@/lib/source-diagnostics';

function getHeaderVal(headers: Headers | Record<string, string> | Array<[string, string]>, name: string): string | undefined {
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
    expect([...EMBED_PROXIED_HOSTS]).toEqual([
      'allappinc.com',
      'anitube22.vip',
      'anitube.biz',
      'anitube.zip',
      'anitube.ninja',
      'hinatasoul.com',
    ]);
    expect([...EMBED_ALLOWED_FINAL_HOSTS]).toEqual([
      'allappinc.com',
      'api.anivideo.net',
      'cdn-sv01.maximaimg.online',
      'cdn-s01.mywallpaper-4k-image.net',
      'anitube.biz',
      'anitube22.vip',
      'anitube.zip',
      'anitube.ninja',
      'hinatasoul.com',
      'animesdigital.org',
    ]);
    expect([...EMBED_DIRECT_HOSTS]).toEqual([
      'animesdigital.org',
      'filevideo1.com',
    ]);
    expect([...EMBED_NO_REFERRER_HOSTS]).toEqual(['filevideo1.com']);
  });

  it('monta URL direta para EMBED_DIRECT_HOSTS/outros e /api/embed?u=... para EMBED_PROXIED_HOSTS', () => {
    const anitubeUrl = 'https://anitube22.vip/playerricas.php?id=123&time=1000';
    expect(buildIframePlayUrl(anitubeUrl)).toBe(
      `/api/embed?u=${encodeURIComponent(anitubeUrl)}`
    );
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

    const evilEntry = new Request(
      `https://app.test/api/embed?u=${encodeURIComponent('https://evil.example.com/embed/1')}`
    );
    expect((await handleEmbedRequest(evilEntry)).status).toBe(403);
  });

  it('segue até 3 saltos dentro de EMBED_ALLOWED_FINAL_HOSTS enviando Referer coempregos para anitube, sem Origin, e remove Set-Cookie/CSP/XFO', async () => {
    const fetchedCalls: Array<{ url: string; referer?: string; origin?: string; ua?: string }> = [];
    const req = new Request(
      `https://app.test/api/embed?u=${encodeURIComponent('https://anitube22.vip/playerricas.php?id=589829')}`,
      { headers: { Origin: 'https://meuplayer.vercel.app' } }
    );

    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = init?.headers;
      const ref = getHeaderVal(headers as any, 'Referer');
      const orig = getHeaderVal(headers as any, 'Origin');
      const ua = getHeaderVal(headers as any, 'User-Agent');
      fetchedCalls.push({ url, referer: ref, origin: orig, ua });

      return new Response('<html><head><title>Player</title></head><body>player ok</body></html>', {
        status: 200,
        headers: {
          'Content-Type': 'text/html',
          'Content-Security-Policy': 'default-src *',
          'X-Frame-Options': 'SAMEORIGIN',
          'Set-Cookie': 'session=secret',
        },
      });
    };

    const res = await handleEmbedRequest(req, {
      fetchImpl: mockFetch as any,
      assertSafeUrl: async (raw) => new URL(raw),
    });

    expect(res.status).toBe(200);
    expect(fetchedCalls).toHaveLength(1);
    expect(fetchedCalls[0].referer).toBe('https://www.coempregos.com.br/');
    expect(fetchedCalls[0].origin).toBeUndefined();
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('x-frame-options')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('cache-control')).toContain('s-maxage=300');
  });
});

describe('Part C: diagnóstico "Testar fonte" com cadeia de saltos e estratégia vencedora', () => {
  it('reporta proxy necessário e /api/embed ok para anitube22.vip/playerricas.php', async () => {
    const report = await diagnoseVideoSource(
      {
        slot: 1,
        url: 'https://anitube22.vip/playerricas.php?id=589829',
      },
      {
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response('<html><body>forbidden wafa</body></html>', {
            status: 403,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          }),
        }),
        embedFetchImpl: async () =>
          new Response('<html><body>playerricas ok</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          }),
        embedAssertSafeUrl: async (raw: string) => new URL(raw),
      }
    );

    expect(report.detectedKind).toBe('iframe');
    expect(report.verdict).toBe('proxy_necessario');
    expect(report.embedDiagnostic?.hostCategory).toBe('proxied');
    expect(report.embedDiagnostic?.embedProxyOk).toBe(true);
  });
});
