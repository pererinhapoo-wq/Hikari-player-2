import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSignedProxyPath,
  verifyProxySignature,
} from '@/lib/proxy-signing';
import { handleProxyStreamRequest } from '@/lib/stream-proxy';
import {
  isDirectMediaUrl,
  isR2StorageUrl,
  inspectR2SourceUrl,
  isVercelBlobUrl,
  normalizeVideoSource,
} from '@/lib/video-sources';

describe('Hikari Player — Testes de Reprodução de MP4 Cloudflare R2 Assinado', () => {
  const TEST_SECRET = '0123456789abcdef0123456789abcdef';

  beforeEach(() => {
    process.env.PLAYER_SESSION_SECRET = TEST_SECRET;
  });

  const syntheticR2Url =
    'https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/zful/589857.mp4?response-content-type=video%2Fmp4&response-content-disposition=inline&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=871d3c7004e00c32e26966ef37249b56%2F20261126%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261126T025518Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=syntheticfakebase64signaturevalueforapitests000000';

  it('1. Reproduz URL R2 assinada com X-Amz-* via proxy', async () => {
    const proxyPath = buildSignedProxyPath(syntheticR2Url, 3600);
    const reqUrl = `http://localhost:3000${proxyPath}`;

    const mockUpstreamResponse = new Response('synthetic-mp4-binary-content', {
      status: 200,
      headers: {
        'content-type': 'video/mp4',
        'content-length': '28',
        'accept-ranges': 'bytes',
      },
    });

    const fetchWithRedirects = vi.fn(async () => ({
      response: mockUpstreamResponse,
      finalUrl: syntheticR2Url,
    }));

    const res = await handleProxyStreamRequest(new Request(reqUrl), {
      fetchWithRedirects,
      nowSeconds: () => 1_700_000_000,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(await res.text()).toBe('synthetic-mp4-binary-content');
  });

  it('2. Preserva exatamente a query string original (parâmetros X-Amz-*)', async () => {
    const proxyPath = buildSignedProxyPath(syntheticR2Url, 3600);
    const parsedReq = new URL(`http://localhost:3000${proxyPath}`);
    const targetParam = parsedReq.searchParams.get('url') ?? '';

    expect(targetParam).toBe(syntheticR2Url);
    expect(targetParam).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(targetParam).toContain('X-Amz-Credential=');
    expect(targetParam).toContain('X-Amz-Signature=');
  });

  it('3. Preserva parâmetros codificados como %2F em valores de assinatura', async () => {
    const urlWithSlashEncoded =
      'https://example.r2.cloudflarestorage.com/video.mp4?X-Amz-Credential=key%2F20261126%2Fregion%2Fs3%2Faws4_request';
    const proxyPath = buildSignedProxyPath(urlWithSlashEncoded, 3600);
    const parsed = new URL(`http://localhost:3000${proxyPath}`);
    const resolvedUrl = parsed.searchParams.get('url') ?? '';

    expect(resolvedUrl).toContain('key%2F20261126%2Fregion%2Fs3%2Faws4_request');
  });

  it('4. Encaminha cabeçalho Range para a origem', async () => {
    const proxyPath = buildSignedProxyPath(syntheticR2Url, 3600);
    let capturedHeaders: Record<string, string> = {};

    const fetchWithRedirects = vi.fn(async (_url: string, opts?: { headers?: Record<string, string> }) => {
      capturedHeaders = opts?.headers ?? {};
      return {
        response: new Response('partial-bytes', {
          status: 206,
          headers: {
            'content-type': 'video/mp4',
            'content-range': 'bytes 0-12/100',
            'content-length': '13',
            'accept-ranges': 'bytes',
          },
        }),
        finalUrl: syntheticR2Url,
      };
    });

    const req = new Request(`http://localhost:3000${proxyPath}`, {
      headers: {
        Range: 'bytes=0-12',
      },
    });

    await handleProxyStreamRequest(req, {
      fetchWithRedirects,
      nowSeconds: () => 1_700_000_000,
    });

    expect(capturedHeaders['Range']).toBe('bytes=0-12');
  });

  it('5 & 6. Suporta resposta 206 Partial Content e preserva Content-Range, Content-Length, Content-Type', async () => {
    const proxyPath = buildSignedProxyPath(syntheticR2Url, 3600);

    const fetchWithRedirects = vi.fn(async () => ({
      response: new Response('chunk-data', {
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-range': 'bytes 100-109/1000',
          'content-length': '10',
          'accept-ranges': 'bytes',
        },
      }),
      finalUrl: syntheticR2Url,
    }));

    const res = await handleProxyStreamRequest(new Request(`http://localhost:3000${proxyPath}`), {
      fetchWithRedirects,
      nowSeconds: () => 1_700_000_000,
    });

    expect(res.status).toBe(206);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-range')).toBe('bytes 100-109/1000');
    expect(res.headers.get('content-length')).toBe('10');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
  });

  it('7. Retorna HTTP 403 da origem sem mascarar o erro', async () => {
    const proxyPath = buildSignedProxyPath(syntheticR2Url, 3600);

    const fetchWithRedirects = vi.fn(async () => ({
      response: new Response('Forbidden by origin', { status: 403 }),
      finalUrl: syntheticR2Url,
    }));

    const res = await handleProxyStreamRequest(new Request(`http://localhost:3000${proxyPath}`), {
      fetchWithRedirects,
      nowSeconds: () => 1_700_000_000,
    });

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Origem retornou erro HTTP 403');
  });

  it('8. Rejeita assinatura de proxy expirada ou adulterada sem fingir validade', async () => {
    const now = 1_700_000_000;
    const expiredExp = now - 100;
    const sig = buildSignedProxyPath(syntheticR2Url, -100, now);
    const parsed = new URL(`http://localhost:3000${sig}`);

    const res = await handleProxyStreamRequest(new Request(parsed.toString()), {
      nowSeconds: () => now,
    });

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Assinatura de proxy inválida ou expirada');
  });

  it('9. Regressão: Suporta MP4 comum e Vercel Blob sem alterar comportamento', () => {
    const commonMp4 = 'https://example.com/video.mp4';
    const normCommon = normalizeVideoSource(commonMp4, 1);
    expect(normCommon?.kind).toBe('mp4');
    expect(normCommon?.provider).toBe('direct');
    expect(normCommon?.needsProxy).toBe(true);

    const blobUrl = 'https://abc123xyz.public.blob.vercel-storage.com/video.mp4';
    expect(isVercelBlobUrl(blobUrl)).toBe(true);
    expect(isDirectMediaUrl(blobUrl)).toBe(true);
    const normBlob = normalizeVideoSource(blobUrl, 1);
    expect(normBlob?.isMirror).toBe(true);
    expect(normBlob?.needsProxy).toBe(false);
  });

  it('10. Regressão: Mantém as três etapas HLS anteriores operacionais', () => {
    const hlsUrl = 'https://cdn-sv01.maximaimg.online/stream/b/bakemonogatari/01.mp4/index.m3u8';
    const normHls = normalizeVideoSource(hlsUrl, 1);
    expect(normHls?.kind).toBe('hls');
    expect(normHls?.needsProxy).toBe(true);
  });

  it('11. Regressão: Mantém proteção de cache R2 (Etapa 1) intacta', () => {
    const inspection = inspectR2SourceUrl(syntheticR2Url);
    expect(inspection.isR2).toBe(true);
    expect(inspection.hasAmzSignature).toBe(true);
    expect(inspection.status).toBe('r2_signed');
    expect(isR2StorageUrl(syntheticR2Url)).toBe(true);
  });
});
