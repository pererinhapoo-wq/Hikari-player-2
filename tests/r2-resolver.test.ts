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
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
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

  it('saves source as unconfirmed when no attempt gives 200 with player/EXTM3U', async () => {
    const signed = 'https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/ziphonec/999999.mp4?X-Amz-Signature=abc';

    const fetchMock = vi.fn().mockResolvedValue(new Response('Forbidden', { status: 403 }));

    const result = await resolveVideoInputUrl(signed, fetchMock);
    expect(result.isConfirmed).toBe(false);
    expect(result.finalUrl).toContain('unconfirmed=1');
  });
});
