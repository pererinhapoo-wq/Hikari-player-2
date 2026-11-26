import { describe, expect, it, vi } from 'vitest';
import { processSiteImportServer } from '@/lib/server-fns';
import {
  assemblePlayerricasUrl,
  decodeAllappincViewParam,
  extractPageMetadata,
  extractSiteImportCandidates,
  importSourceFromEpisodePage,
  isAllowedSiteImportHost,
} from '@/lib/site-import';

describe('Site Import from Episode Page', () => {
  it('decodifica parâmetro view em hexadecimal com substituição de letras (exemplo obrigatório)', () => {
    expect(
      decodeAllappincViewParam(
        '68747470733n2s2s7777772r616r69747562652r62697n2s353635303430'
      )
    ).toBe('https://www.anitube.biz/565040');
    expect(decodeAllappincViewParam('invalido!')).toBeNull();
    expect(decodeAllappincViewParam('')).toBeNull();
  });

  it('valida hosts permitidos para importação de site (anitube.biz, anitube22.vip e allappinc.com)', () => {
    expect(isAllowedSiteImportHost('anitube.biz')).toBe(true);
    expect(isAllowedSiteImportHost('www.anitube.biz')).toBe(true);
    expect(isAllowedSiteImportHost('sub.anitube.biz')).toBe(true);
    expect(isAllowedSiteImportHost('anitube22.vip')).toBe(true);
    expect(isAllowedSiteImportHost('cdn.anitube22.vip')).toBe(true);
    expect(isAllowedSiteImportHost('allappinc.com')).toBe(true);
    expect(isAllowedSiteImportHost('www.allappinc.com')).toBe(true);
    expect(isAllowedSiteImportHost('evil.com')).toBe(false);
    expect(isAllowedSiteImportHost('anitube.biz.evil.com')).toBe(false);
    expect(isAllowedSiteImportHost('allappinc.com.evil.com')).toBe(false);
    expect(isAllowedSiteImportHost('127.0.0.1')).toBe(false);
  });

  it('monta URL do playerricas.php corretamente preenchendo parametros exigidos', () => {
    const raw = 'https://anitube.biz/playerricas.php?name=ep1.mp4&pais=br';
    const assembled = assemblePlayerricasUrl(raw, 'https://anitube.biz/ep/1', {}, 1700000000);
    expect(assembled).not.toBeNull();
    const urlObj = new URL(assembled!);
    expect(urlObj.searchParams.get('name')).toBe('ep1.mp4');
    expect(urlObj.searchParams.get('pais')).toBe('br');
    expect(urlObj.searchParams.get('img')).toBe('');
    expect(urlObj.searchParams.get('time')).toBe('1700000000');
    expect(urlObj.searchParams.get('url')).toBe('');
  });

  it('extrai metadados e candidatos do HTML na ordem correta (iframe playerricas -> m3u8 -> mp4)', () => {
    const html = `
      <!doctype html>
      <html>
        <head>
          <title>Anime Episode 1</title>
          <meta property="og:image" content="https://anitube.biz/img/poster1.jpg" />
        </head>
        <body>
          <iframe src="https://anitube.biz/playerricas.php?name=ep1.mp4"></iframe>
          <a href="https://cdn-sv01.maximaimg.online/stream/ep1/index.m3u8">M3U8 link</a>
          <video src="https://cdn.example.com/videos/ep1.mp4"></video>
        </body>
      </html>
    `;

    const meta = extractPageMetadata(html, 'https://anitube.biz/ep/1');
    expect(meta.title).toBe('Anime Episode 1');
    expect(meta.poster).toBe('https://anitube.biz/img/poster1.jpg');

    const candidates = extractSiteImportCandidates(html, 'https://anitube.biz/ep/1', 1700000000);
    expect(candidates).toHaveLength(3);
    expect(candidates[0].type).toBe('playerricas');
    expect(candidates[1].type).toBe('m3u8');
    expect(candidates[2].type).toBe('mp4');
    expect(candidates[0].url).toContain('playerricas.php');
  });

  it('importa com sucesso o primeiro candidato válido (200 com playlist m3u8) e define forceProxy true, kind hls e referer do host', async () => {
    const pageUrl = 'https://anitube.biz/anime/ep-1/';
    const m3u8Url = 'https://cdn-sv01.maximaimg.online/stream/ep1/index.m3u8';

    const result = await importSourceFromEpisodePage(pageUrl, {
      fetchWithRedirects: async (url) => {
        if (url === pageUrl) {
          return {
            finalUrl: pageUrl,
            response: new Response(
              '<html><head><title>Ep 1</title></head><body><a href="' +
                m3u8Url +
                '">stream</a></body></html>',
              {
                status: 200,
                headers: { 'content-type': 'text/html' },
              }
            ),
          };
        }
        if (url === m3u8Url) {
          return {
            finalUrl: m3u8Url,
            response: new Response('#EXTM3U\n#EXT-X-VERSION:3\nseg1.ts', {
              status: 200,
              headers: { 'content-type': 'application/vnd.apple.mpegurl' },
            }),
          };
        }
        return { finalUrl: url, response: new Response('Not Found', { status: 404 }) };
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selected.url).toBe(m3u8Url);
      expect(result.selected.kind).toBe('hls');
      expect(result.selected.forceProxy).toBe(true);
      expect(result.selected.hostReferer).toBe('https://www.anitube.biz/');
      expect(result.extractedTitle).toBe('Ep 1');
    }
  });

  it('rejeita candidatos 403 / 404 / html inválido e retorna erro com diagnóstico de cada candidato', async () => {
    const pageUrl = 'https://anitube.biz/anime/ep-2/';
    const badUrl = 'https://cdn-sv01.maximaimg.online/stream/dead/index.m3u8';

    const result = await importSourceFromEpisodePage(pageUrl, {
      fetchWithRedirects: async (url) => {
        if (url === pageUrl) {
          return {
            finalUrl: pageUrl,
            response: new Response(
              '<html><body><a href="' + badUrl + '">dead</a></body></html>',
              {
                status: 200,
                headers: { 'content-type': 'text/html' },
              }
            ),
          };
        }
        return { finalUrl: url, response: new Response('Forbidden', { status: 403 }) };
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].passed).toBe(false);
      expect(result.candidates[0].status).toBe(403);
    }
  });

  it('detecta link expirável (X-Amz-Expires, token= ou sig=)', async () => {
    const pageUrl = 'https://anitube.biz/anime/ep-3/';
    const expirableUrl = 'https://cdn-s01.mywallpaper-4k-image.net/video/index.m3u8?token=secret99';

    const result = await importSourceFromEpisodePage(pageUrl, {
      fetchWithRedirects: async (url) => {
        if (url === pageUrl) {
          return {
            finalUrl: pageUrl,
            response: new Response(
              '<html><body><a href="' + expirableUrl + '">exp</a></body></html>',
              { status: 200, headers: { 'content-type': 'text/html' } }
            ),
          };
        }
        return {
          finalUrl: url,
          response: new Response('#EXTM3U\nseg1.ts', {
            status: 200,
            headers: { 'content-type': 'application/vnd.apple.mpegurl' },
          }),
        };
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selected.isExpirable).toBe(true);
      expect(result.selected.expirableReason).toMatch(/expirável/i);
    }
  });

  it('decodifica parâmetro view do allappinc antes de buscar e vai direto à URL decodificada', async () => {
    const allappincUrl =
      'https://allappinc.com/?view=68747470733n2s2s7777772r616r69747562652r62697n2s353635303430';
    const expectedAnitubeUrl = 'https://www.anitube.biz/565040';
    const mediaUrl = 'https://cdn-x01.novo-provedor.net/stream/ep565040/index.m3u8';
    const fetchedUrls: string[] = [];

    const result = await importSourceFromEpisodePage(allappincUrl, {
      assertSafeUrl: async (raw) => new URL(raw),
      fetchWithRedirects: async (url) => {
        fetchedUrls.push(url);
        if (url === expectedAnitubeUrl) {
          return {
            finalUrl: expectedAnitubeUrl,
            response: new Response(
              `<html><head><title>Ep 565040</title></head><body><a href="${mediaUrl}">play</a></body></html>`,
              { status: 200, headers: { 'content-type': 'text/html' } }
            ),
          };
        }
        if (url === mediaUrl) {
          return {
            finalUrl: mediaUrl,
            response: new Response('#EXTM3U\nseg1.ts', {
              status: 200,
              headers: { 'content-type': 'application/vnd.apple.mpegurl' },
            }),
          };
        }
        return { finalUrl: url, response: new Response('Not Found', { status: 404 }) };
      },
    });

    expect(fetchedUrls).not.toContain(allappincUrl);
    expect(fetchedUrls[0]).toBe(expectedAnitubeUrl);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pageUrl).toBe(expectedAnitubeUrl);
      expect(result.selected.url).toBe(mediaUrl);
      expect(result.selected.hostReferer).toBe('https://www.anitube.biz/');
    }
  });

  it('quando decodificação de view falha, busca página do allappinc e segue redirect HTTP, meta refresh ou link para anitube', async () => {
    const mediaUrl = 'https://cdn-sv01.maximaimg.online/stream/ep10/index.m3u8';

    // (a) Redirect HTTP 3xx para anitube
    const resRedirect = await importSourceFromEpisodePage(
      'https://allappinc.com/?view=invalido_xyz',
      {
        fetchWithRedirects: async (url) => {
          if (url.startsWith('https://allappinc.com/')) {
            return {
              finalUrl: 'https://www.anitube.biz/565040',
              response: new Response(
                `<html><body><a href="${mediaUrl}">m3u8</a></body></html>`,
                { status: 200, headers: { 'content-type': 'text/html' } }
              ),
            };
          }
          return {
            finalUrl: mediaUrl,
            response: new Response('#EXTM3U\nseg1.ts', {
              status: 200,
              headers: { 'content-type': 'application/vnd.apple.mpegurl' },
            }),
          };
        },
      }
    );
    expect(resRedirect.ok).toBe(true);
    if (resRedirect.ok) {
      expect(resRedirect.pageUrl).toBe('https://www.anitube.biz/565040');
    }

    // (b) Meta refresh para anitube
    const resMeta = await importSourceFromEpisodePage('https://allappinc.com/go/1', {
      fetchWithRedirects: async (url) => {
        if (url === 'https://allappinc.com/go/1') {
          return {
            finalUrl: url,
            response: new Response(
              '<html><head><meta http-equiv="refresh" content="0;url=https://www.anitube.biz/565041"></head><body></body></html>',
              { status: 200, headers: { 'content-type': 'text/html' } }
            ),
          };
        }
        if (url === 'https://www.anitube.biz/565041') {
          return {
            finalUrl: url,
            response: new Response(
              `<html><body><a href="${mediaUrl}">m3u8</a></body></html>`,
              { status: 200, headers: { 'content-type': 'text/html' } }
            ),
          };
        }
        return {
          finalUrl: url,
          response: new Response('#EXTM3U\nseg1.ts', {
            status: 200,
            headers: { 'content-type': 'application/vnd.apple.mpegurl' },
          }),
        };
      },
    });
    expect(resMeta.ok).toBe(true);
    if (resMeta.ok) {
      expect(resMeta.pageUrl).toBe('https://www.anitube.biz/565041');
    }

    // (c) Link <a> para anitube22.vip
    const resLink = await importSourceFromEpisodePage('https://allappinc.com/go/2', {
      fetchWithRedirects: async (url) => {
        if (url === 'https://allappinc.com/go/2') {
          return {
            finalUrl: url,
            response: new Response(
              '<html><body><a href="https://anitube22.vip/">Home</a><a href="https://anitube22.vip/ep-99">Ir para episódio</a></body></html>',
              { status: 200, headers: { 'content-type': 'text/html' } }
            ),
          };
        }
        if (url === 'https://anitube22.vip/ep-99') {
          return {
            finalUrl: url,
            response: new Response(
              `<html><body><a href="${mediaUrl}">m3u8</a></body></html>`,
              { status: 200, headers: { 'content-type': 'text/html' } }
            ),
          };
        }
        return {
          finalUrl: url,
          response: new Response('#EXTM3U\nseg1.ts', {
            status: 200,
            headers: { 'content-type': 'application/vnd.apple.mpegurl' },
          }),
        };
      },
    });
    expect(resLink.ok).toBe(true);
    if (resLink.ok) {
      expect(resLink.pageUrl).toBe('https://anitube22.vip/ep-99');
    }
  });

  it('tenta https://www.anitube.biz/ como referer principal em subdomínio cdn-* e cai para referers antigos em caso de 403', async () => {
    const pageUrl = 'https://www.anitube.biz/565040';
    const cdnUrl = 'https://cdn-s02.novo-provedor.net/stream/ep565040/index.m3u8';
    const triedReferers: Array<string | undefined> = [];

    const result = await importSourceFromEpisodePage(pageUrl, {
      assertSafeUrl: async (raw) => new URL(raw),
      fetchWithRedirects: async (url, opts) => {
        if (url === pageUrl) {
          return {
            finalUrl: pageUrl,
            response: new Response(
              `<html><body><a href="${cdnUrl}">stream</a></body></html>`,
              { status: 200, headers: { 'content-type': 'text/html' } }
            ),
          };
        }
        const ref = opts?.headers?.['Referer'];
        triedReferers.push(ref);
        if (ref === 'https://www.coempregos.com.br/') {
          return {
            finalUrl: cdnUrl,
            response: new Response('#EXTM3U\nseg1.ts', {
              status: 200,
              headers: { 'content-type': 'application/vnd.apple.mpegurl' },
            }),
          };
        }
        return { finalUrl: cdnUrl, response: new Response('Forbidden', { status: 403 }) };
      },
    });

    expect(triedReferers).toEqual([
      'https://www.anitube.biz/',
      'https://api.anivideo.net/',
      'https://www.coempregos.com.br/',
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selected.url).toBe(cdnUrl);
      expect(result.selected.hostReferer).toBe('https://www.coempregos.com.br/');
    }
  });

  it('quando todos os referers dão 403, responde "host exige referer desconhecido" com o status de cada tentativa', async () => {
    const pageUrl = 'https://www.anitube.biz/565040';
    const cdnUrl = 'https://cdn-s03.bloqueado.net/stream/ep1/index.m3u8';

    const result = await importSourceFromEpisodePage(pageUrl, {
      assertSafeUrl: async (raw) => new URL(raw),
      fetchWithRedirects: async (url) => {
        if (url === pageUrl) {
          return {
            finalUrl: pageUrl,
            response: new Response(
              `<html><body><a href="${cdnUrl}">stream</a></body></html>`,
              { status: 200, headers: { 'content-type': 'text/html' } }
            ),
          };
        }
        return { finalUrl: cdnUrl, response: new Response('Forbidden', { status: 403 }) };
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toContain('host exige referer desconhecido');
      expect(result.error).toContain('https://www.anitube.biz/ -> HTTP 403');
      expect(result.error).toContain('https://api.anivideo.net/ -> HTTP 403');
      expect(result.error).toContain('https://www.coempregos.com.br/ -> HTTP 403');
      expect(result.candidates[0].attempts?.length).toBeGreaterThanOrEqual(3);
      expect(result.candidates[0].attempts?.every((a) => a.status === 403)).toBe(true);
    }
  });

  it('403 nunca barra a importação (continua para o próximo candidato), enquanto 404 e 200 com html descartam o candidato', async () => {
    const pageUrl = 'https://www.anitube.biz/565040';
    const html200Url = 'https://cdn-a.provedor.net/fake/index.m3u8';
    const notFound404Url = 'https://cdn-b.provedor.net/missing/index.m3u8';
    const all403Url = 'https://cdn-c.provedor.net/blocked/index.m3u8';
    const validMp4Url = 'https://cdn-d.provedor.net/video/ep565040.mp4';

    const fetchCallsByUrl = new Map<string, number>();

    const result = await importSourceFromEpisodePage(pageUrl, {
      assertSafeUrl: async (raw) => new URL(raw),
      fetchWithRedirects: async (url) => {
        fetchCallsByUrl.set(url, (fetchCallsByUrl.get(url) ?? 0) + 1);
        if (url === pageUrl) {
          return {
            finalUrl: pageUrl,
            response: new Response(
              `<html><body>
                <a href="${html200Url}">html200</a>
                <a href="${notFound404Url}">404</a>
                <a href="${all403Url}">403</a>
                <video src="${validMp4Url}"></video>
              </body></html>`,
              { status: 200, headers: { 'content-type': 'text/html' } }
            ),
          };
        }
        if (url === html200Url) {
          return {
            finalUrl: url,
            response: new Response('<!doctype html><html><body>fake</body></html>', {
              status: 200,
              headers: { 'content-type': 'text/html' },
            }),
          };
        }
        if (url === notFound404Url) {
          return { finalUrl: url, response: new Response('Not Found', { status: 404 }) };
        }
        if (url === all403Url) {
          return { finalUrl: url, response: new Response('Forbidden', { status: 403 }) };
        }
        if (url === validMp4Url) {
          return {
            finalUrl: url,
            response: new Response(new Uint8Array([0, 0, 0, 24]), {
              status: 200,
              headers: { 'content-type': 'video/mp4' },
            }),
          };
        }
        return { finalUrl: url, response: new Response('Not Found', { status: 404 }) };
      },
    });

    expect(result.ok).toBe(true);
    // 200 com HTML e 404 encerram imediatamente na 1ª tentativa; 403 tenta todos os referers mas não barra o MP4 seguinte
    expect(fetchCallsByUrl.get(html200Url)).toBe(1);
    expect(fetchCallsByUrl.get(notFound404Url)).toBe(1);
    expect(fetchCallsByUrl.get(all403Url)).toBeGreaterThan(1);
    if (result.ok) {
      expect(result.selected.url).toBe(validMp4Url);
      expect(result.selected.kind).toBe('mp4');
      expect(result.candidates.map((c) => c.passed)).toEqual([false, false, false, true]);
    }
  });

  it('processSiteImportServer não grava fonte no banco quando todos os referers dão 403', async () => {
    const pageUrl = 'https://www.anitube.biz/565040';
    const cdnUrl = 'https://cdn-s03.bloqueado.net/stream/ep1/index.m3u8';
    const saveSource = vi.fn();

    const serverRes = await processSiteImportServer(
      { pageUrl, episodeId: 'ep-123', targetSlot: 1 },
      {
        isDbConfigured: () => true,
        saveSource,
        importDeps: {
          assertSafeUrl: async (raw) => new URL(raw),
          fetchWithRedirects: async (url) => {
            if (url === pageUrl) {
              return {
                finalUrl: pageUrl,
                response: new Response(
                  `<html><body><a href="${cdnUrl}">stream</a></body></html>`,
                  { status: 200, headers: { 'content-type': 'text/html' } }
                ),
              };
            }
            return { finalUrl: cdnUrl, response: new Response('Forbidden', { status: 403 }) };
          },
        },
      }
    );

    expect(saveSource).not.toHaveBeenCalled();
    expect(serverRes.ok).toBe(false);
    if (!serverRes.ok) {
      expect(serverRes.error.toLowerCase()).toContain('host exige referer desconhecido');
      expect(serverRes.error).toContain('HTTP 403');
    }
  });
});
