import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isR2SignedUrl,
  cleanR2SignedUrl,
  extractFilenameFromPath,
  extractPlayerricasIframeFromHtml,
  extractPrefixFromPlayerricasName,
  resolvePrefixFromEpisodePage,
  resolveVideoInputUrl,
} from '@/lib/r2-resolver';

describe('R2 Resolver and Prefix Verification', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('detects R2 signed URLs with X-Amz-Signature', () => {
    const signed = 'https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/ziphonec/583375.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc123xyz&response-content-disposition=inline';
    expect(isR2SignedUrl(signed)).toBe(true);

    const unsigned = 'https://example.com/video.mp4';
    expect(isR2SignedUrl(unsigned)).toBe(false);
  });

  it('cleans R2 signed URL by removing X-Amz-* and response-* parameters', () => {
    const signed = 'https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/ziphonec/583375.mp4?X-Amz-Algorithm=AWS4&X-Amz-Signature=abc&response-content-disposition=inline&custom=1';
    const cleaned = cleanR2SignedUrl(signed);
    expect(cleaned).not.toContain('X-Amz-Signature');
    expect(cleaned).toContain('custom=1');
  });

  it('discards 403, 401, 429, timeouts and approves only on 200 with player or EXTM3U', async () => {
    const signed = 'https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/ziphonec/583375.mp4?X-Amz-Signature=abc';

    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // apphd -> 403 (should discard, not fail)
        return new Response('Forbidden', { status: 403 });
      }
      if (callCount === 2) {
        // appsd -> 200 with player content
        return new Response('<html><body>player loaded successfully</body></html>', { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    });

    const result = await resolveVideoInputUrl(signed, fetchMock);
    expect(result.prefix).toBe('appsd');
    expect(result.isConfirmed).toBe(true);
    expect(result.isAttempt).toBe(true);
  });

  it('nunca aprova ou grava prefixo apphd quando nenhuma tentativa retorna 200', async () => {
    const signed = 'https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/ziphonec/589829.mp4?X-Amz-Signature=abc';

    const fetchMock = vi.fn().mockResolvedValue(new Response('Forbidden', { status: 403 }));

    const result = await resolveVideoInputUrl(signed, fetchMock);
    expect(result.isConfirmed).toBe(false);
    expect(result.prefix).toBeNull();
    expect(result.finalUrl).toBe(
      'https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/ziphonec/589829.mp4'
    );
    expect(result.finalUrl).not.toContain('apphd');
  });

  it('extrai prefixo do src do iframe da página do episódio e só confirma quando responde 200', async () => {
    const html =
      '<html><body><iframe src="https://anitube22.vip/playerricas.php?name=appsd/589829.mp4&amp;url=https://r2.example/589829.mp4"></iframe></body></html>';
    expect(extractPlayerricasIframeFromHtml(html)).toBe(
      'https://anitube22.vip/playerricas.php?name=appsd/589829.mp4&url=https://r2.example/589829.mp4'
    );

    const confirmed = await resolvePrefixFromEpisodePage(
      'https://www.anitube22.vip/episodio/589829',
      (async (url: string) => {
        if (url.includes('episodio/589829')) {
          return new Response(html, { status: 200 });
        }
        return new Response('<html><body>player ok</body></html>', { status: 200 });
      }) as any
    );
    expect(confirmed).toEqual({
      playerricasUrl:
        'https://anitube22.vip/playerricas.php?name=appsd/589829.mp4&url=https://r2.example/589829.mp4',
      prefix: 'appsd',
      isConfirmed: true,
    });

    const deniedOn403 = await resolvePrefixFromEpisodePage(
      'https://www.anitube22.vip/episodio/589829',
      (async (url: string) => {
        if (url.includes('episodio/589829')) {
          return new Response(html, { status: 200 });
        }
        return new Response('Why have I been blocked', { status: 403 });
      }) as any
    );
    expect(deniedOn403).toEqual({
      playerricasUrl: null,
      prefix: null,
      isConfirmed: false,
    });
  });
});
