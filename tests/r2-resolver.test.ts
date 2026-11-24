import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isR2SignedUrl,
  cleanR2SignedUrl,
  extractFilenameFromPath,
  extractPrefixFromPlayerricasName,
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

    const r2WithoutAmz = 'https://account.r2.cloudflarestorage.com/bucket/file.mp4';
    expect(isR2SignedUrl(r2WithoutAmz)).toBe(false);
  });

  it('cleans R2 signed URL by removing X-Amz-* and response-* parameters', () => {
    const signed = 'https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/ziphonec/583375.mp4?X-Amz-Algorithm=AWS4&X-Amz-Signature=abc&response-content-disposition=inline&custom=1';
    const cleaned = cleanR2SignedUrl(signed);
    expect(cleaned).not.toContain('X-Amz-Algorithm');
    expect(cleaned).not.toContain('X-Amz-Signature');
    expect(cleaned).not.toContain('response-content-disposition');
    expect(cleaned).toContain('custom=1');
    expect(cleaned).toContain('583375.mp4');
  });

  it('extracts filename and prefix correctly', () => {
    expect(extractFilenameFromPath('/ziphonec/folder/583375.mp4')).toBe('583375.mp4');
    expect(extractPrefixFromPlayerricasName('apphd/583375.mp4')).toBe('apphd');
    expect(extractPrefixFromPlayerricasName('unknown/file.mp4')).toBeNull();
    expect(extractPrefixFromPlayerricasName(null)).toBeNull();
  });

  it('takes direct parse priority for playerricas.php URLs without trial attempts', async () => {
    const playerricasUrl = 'https://www.anitube22.vip/playerricas.php?name=apphd/583375.mp4&url=https://r2/ziphonec/583375.mp4';
    const fetchMock = vi.fn();

    const result = await resolveVideoInputUrl(playerricasUrl, fetchMock);
    expect(result.finalUrl).toBe(playerricasUrl);
    expect(result.prefix).toBe('apphd');
    expect(result.isAttempt).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('discovers prefix by verification for R2 signed URLs and succeeds on correct prefix', async () => {
    const signed = 'https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/ziphonec/583375.mp4?X-Amz-Signature=abc';
    
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const decoded = decodeURIComponent(url);
      if (decoded.includes('appsd/583375.mp4')) {
        return new Response('<html><body>player loaded</body></html>', { status: 200 });
      }
      return new Response('deleted not found', { status: 404 });
    });

    const result = await resolveVideoInputUrl(signed, fetchMock);
    expect(result.prefix).toBe('appsd');
    expect(result.isAttempt).toBe(true);
    expect(decodeURIComponent(result.finalUrl)).toContain('appsd/583375.mp4');
    expect(result.finalUrl).toContain('url=');
    expect(result.finalUrl).not.toContain('X-Amz-Signature');
  });

  it('refuses saving and throws error when all prefix attempts fail (404 or deleted)', async () => {
    const signed = 'https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/ziphonec/999999.mp4?X-Amz-Signature=abc';

    const fetchMock = vi.fn().mockResolvedValue(new Response('deleted not found', { status: 404 }));

    await expect(resolveVideoInputUrl(signed, fetchMock)).rejects.toThrow(
      'prefixo do arquivo não encontrado, cole a URL do playerricas.php'
    );
  });
});
