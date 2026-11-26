import { describe, expect, it } from 'vitest';
import {
  assemblePlayerricasUrl,
  extractPageMetadata,
  extractSiteImportCandidates,
  importSourceFromEpisodePage,
  isAllowedSiteImportHost,
} from '@/lib/site-import';

describe('Site Import from Episode Page', () => {
  it('valida hosts permitidos para importação de site (anitube.biz e anitube22.vip)', () => {
    expect(isAllowedSiteImportHost('anitube.biz')).toBe(true);
    expect(isAllowedSiteImportHost('www.anitube.biz')).toBe(true);
    expect(isAllowedSiteImportHost('sub.anitube.biz')).toBe(true);
    expect(isAllowedSiteImportHost('anitube22.vip')).toBe(true);
    expect(isAllowedSiteImportHost('cdn.anitube22.vip')).toBe(true);
    expect(isAllowedSiteImportHost('evil.com')).toBe(false);
    expect(isAllowedSiteImportHost('anitube.biz.evil.com')).toBe(false);
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
});
