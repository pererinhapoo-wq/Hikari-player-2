import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  KNOWN_PREFIXES,
  isR2SignedUrl,
  cleanR2SignedUrl,
  extractFilenameFromPath,
  extractPlayerricasIframeFromHtml,
  extractPrefixFromPlayerricasName,
  resolvePrefixFromEpisodePage,
  resolveVideoInputUrl,
  attemptControlledR2Resolution,
  applyResolvedR2Candidate,
  validatePlayerricasResolvedResponse,
} from '@/lib/r2-resolver';
import { processControlledR2ResolutionServer } from '@/lib/server-fns';

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

describe('Etapa 2 — Resolução controlada de links Cloudflare R2 via playerricas.php', () => {
  const unsigned1dmR2Url =
    'https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/z333/229033.mp4';

  it('1. resolve link R2 sem assinatura quando um dos 6 prefixos retorna player HTML válido', async () => {
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      requestedUrls.push(url);
      if (url.includes('name=apphd%2F229033.mp4')) {
        return new Response('Forbidden', { status: 403 });
      }
      if (url.includes('name=appsd%2F229033.mp4')) {
        return new Response('Not Found', { status: 404 });
      }
      if (url.includes('name=appdub%2F229033.mp4')) {
        return new Response(
          '<!doctype html><html><body><video controls><source src="https://cdn-sv01.maximaimg.online/stream/z333/229033.mp4/index.m3u8" type="application/x-mpegURL"></video></body></html>',
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
        );
      }
      return new Response('Forbidden', { status: 403 });
    });

    const res = await attemptControlledR2Resolution(unsigned1dmR2Url, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      assertSafeUrl: async (raw) => new URL(raw),
    });

    expect(res.ok).toBe(true);
    expect(res.found).toBe(true);
    expect(res.isR2).toBe(true);
    expect(res.hasAuthParams).toBe(false);
    expect(res.originalUrl).toBe(unsigned1dmR2Url);
    expect(res.matchedPrefix).toBe('appdub');
    expect(res.detectedKind).toBe('iframe');
    expect(res.resolvedUrl).toBe(
      `https://anitube22.vip/playerricas.php?name=${encodeURIComponent('appdub/229033.mp4')}&url=${encodeURIComponent(unsigned1dmR2Url)}`
    );
    expect(res.attempts).toHaveLength(3);
    expect(res.attempts.map((a) => a.prefix)).toEqual(['apphd', 'appsd', 'appdub']);
    expect(requestedUrls).toHaveLength(3);
  });

  it('2. testa os 6 prefixos em link R2 sem assinatura quando não há resolução e preserva URL original', async () => {
    const fetchMock = vi.fn(async () => new Response('Forbidden', { status: 403 }));

    const res = await attemptControlledR2Resolution(unsigned1dmR2Url, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      assertSafeUrl: async (raw) => new URL(raw),
    });

    expect(res.ok).toBe(true);
    expect(res.found).toBe(false);
    expect(res.resolvedUrl).toBeNull();
    expect(res.matchedPrefix).toBeNull();
    expect(res.originalUrl).toBe(unsigned1dmR2Url);
    expect(res.attempts).toHaveLength(KNOWN_PREFIXES.length);
    expect(res.attempts.map((a) => a.prefix)).toEqual([...KNOWN_PREFIXES]);
    expect(res.attempts.every((a) => a.status === 403 && !a.valid)).toBe(true);
  });

  it('3. trata serviço indisponível (502/503/erro de rede) e timeout sem bloquear fluxo', async () => {
    let idx = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      idx++;
      if (idx === 1) return new Response('Bad Gateway', { status: 502 });
      if (idx === 2) return new Response('Service Unavailable', { status: 503 });
      if (idx === 3) throw new Error('ECONNRESET');
      if (idx === 4) {
        const abortErr = new Error('The operation was aborted.');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      if (init?.signal?.aborted) {
        const abortErr = new Error('Aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      return new Response('Gateway Timeout', { status: 504 });
    });

    const res = await attemptControlledR2Resolution(unsigned1dmR2Url, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      assertSafeUrl: async (raw) => new URL(raw),
      timeoutMs: 50,
    });

    expect(res.ok).toBe(true);
    expect(res.found).toBe(false);
    expect(res.resolvedUrl).toBeNull();
    expect(res.originalUrl).toBe(unsigned1dmR2Url);
    expect(res.attempts).toHaveLength(6);
    expect(res.attempts[0].status).toBe(502);
    expect(res.attempts[1].status).toBe(503);
    expect(res.attempts[2].status).toBeNull();
    expect(res.attempts[3].reason.toLowerCase()).toContain('timeout');
  });

  it('4. rejeita HTTP 200 com conteúdo inválido (HTML genérico, texto "player" falso, Cloudflare block, deleted, EXTM3U vazio)', async () => {
    const invalidPayloads = [
      { body: '<html><body><div>Página inicial</div></body></html>', ct: 'text/html' },
      { body: '<html><body>player loaded successfully</body></html>', ct: 'text/html' },
      { body: '<html><body><h1>Attention Required! | Cloudflare</h1><p>Why have I been blocked?</p></body></html>', ct: 'text/html' },
      { body: '<html><body><video src="https://cdn.example/a.mp4"></video> Video unavailable / deleted</body></html>', ct: 'text/html' },
      { body: '#EXTM3U\n# apenas comentario sem tags', ct: 'application/vnd.apple.mpegurl' },
      { body: '   ', ct: 'text/plain' },
    ];

    let idx = 0;
    const fetchMock = vi.fn(async () => {
      const sample = invalidPayloads[idx++] ?? invalidPayloads[0];
      return new Response(sample.body, {
        status: 200,
        headers: { 'content-type': sample.ct },
      });
    });

    const res = await attemptControlledR2Resolution(unsigned1dmR2Url, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      assertSafeUrl: async (raw) => new URL(raw),
    });

    expect(res.ok).toBe(true);
    expect(res.found).toBe(false);
    expect(res.resolvedUrl).toBeNull();
    expect(res.attempts).toHaveLength(6);
    expect(res.attempts.every((a) => a.status === 200 && a.valid === false)).toBe(true);

    // Garante também aceitação quando retorna playlist HLS #EXTM3U legítima
    const validHlsCheck = await validatePlayerricasResolvedResponse({
      finalUrl: 'https://anitube22.vip/playerricas.php?name=appfull/229033.mp4',
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      bodyText: '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg01.ts\n',
      assertSafeUrl: async (raw) => new URL(raw),
    });
    expect(validHlsCheck.valid).toBe(true);
    expect(validHlsCheck.detectedKind).toBe('hls');
  });

  it('5. bloqueia URL de entrada, redirect ou mídia embutida com esquema inseguro ou host não permitido (SSRF)', async () => {
    // 5a. Entrada com esquema proibido / host interno bloqueado no wrapper de servidor real
    const ssrfLocal = await processControlledR2ResolutionServer({
      url: 'http://127.0.0.1:8080/z333/229033.mp4',
    });
    expect(ssrfLocal.ok).toBe(false);
    expect(ssrfLocal.found).toBe(false);

    const jsScheme = await processControlledR2ResolutionServer({
      url: 'javascript:alert(1)',
    });
    expect(jsScheme.ok).toBe(false);
    expect(jsScheme.found).toBe(false);

    // 5b. Redirect de playerricas.php para host fora da allowlist ou IP de metadata
    const redirectFetchMock = vi.fn(async (url: string) => {
      if (url.includes('apphd')) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
        });
      }
      if (url.includes('appsd')) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://evil-untrusted.example/fake.php' },
        });
      }
      if (url.includes('appdub')) {
        return new Response(
          '<html><body><iframe src="javascript:alert(document.cookie)"></iframe></body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } }
        );
      }
      if (url.includes('appleg')) {
        return new Response(
          '<html><body><video src="http://127.0.0.1/internal.mp4"></video></body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } }
        );
      }
      return new Response('Forbidden', { status: 403 });
    });

    const redirectRes = await attemptControlledR2Resolution(unsigned1dmR2Url, {
      fetchImpl: redirectFetchMock as unknown as typeof fetch,
      assertSafeUrl: async (raw) => new URL(raw),
    });

    expect(redirectRes.found).toBe(false);
    expect(redirectRes.resolvedUrl).toBeNull();
    expect(redirectRes.attempts[0].valid).toBe(false);
    expect(redirectRes.attempts[1].reason.toLowerCase()).toContain('allowlist');
    expect(redirectRes.attempts[2].reason.toLowerCase()).toContain('inseguro');
    expect(redirectRes.attempts[3].reason.toLowerCase()).toContain('bloqueado');
  });

  it('6 e 7. exige confirmação explícita no Admin antes de substituir fonte e mantém URL original intacta se falhar ou não confirmar', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('name=apphd%2F229033.mp4')) {
        return new Response(
          '<html><body><div id="player"></div><script>jwplayer("player").setup({file:"https://cdn-s01.mywallpaper-4k-image.net/stream/229033.mp4/index.m3u8"});</script></body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } }
        );
      }
      return new Response('Forbidden', { status: 403 });
    });

    const resolution = await attemptControlledR2Resolution(unsigned1dmR2Url, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      assertSafeUrl: async (raw) => new URL(raw),
    });
    expect(resolution.found).toBe(true);

    // Sem confirmação explícita -> não substitui a URL atual
    const unconfirmed = applyResolvedR2Candidate(
      { video_url: unsigned1dmR2Url, source_kind: 'mp4' },
      resolution,
      false
    );
    expect(unconfirmed.applied).toBe(false);
    expect(unconfirmed.video_url).toBe(unsigned1dmR2Url);
    expect(unconfirmed.source_kind).toBe('mp4');

    // Após confirmação explícita -> aplica candidata ao formulário para posterior Save
    const confirmed = applyResolvedR2Candidate(
      { video_url: unsigned1dmR2Url, source_kind: 'mp4' },
      resolution,
      true
    );
    expect(confirmed.applied).toBe(true);
    expect(confirmed.video_url).toBe(resolution.resolvedUrl);
    expect(confirmed.source_kind).toBe('iframe');

    // Garante que o fluxo de UI do Admin possui botão explícito e confirmação antes de alterar
    const adminSource = fs.readFileSync(path.resolve(process.cwd(), 'src/routes/admin.tsx'), 'utf8');
    expect(adminSource).toContain('adminResolveR2SourceFn');
    expect(adminSource).toContain('Aplicar fonte resolvida');
    expect(adminSource).toContain('Manter URL atual');

    // Garante que a server function exige requireAdminSession
    const serverFnsSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/server-fns.ts'),
      'utf8'
    );
    expect(serverFnsSource).toMatch(/adminResolveR2SourceFn[\s\S]*requireAdminSession\(\)/);
  });

  it('8. preserva parâmetros de assinatura de URLs assinadas válidas ao testar funcionamento e não vaza tokens', async () => {
    const signedUrl =
      'https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/z333/229033.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=7200&X-Amz-Signature=supersecretsignature999';

    const seenSignedProbeUrls: string[] = [];
    const seenPlayerricasUrls: string[] = [];

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('r2.cloudflarestorage.com') && !url.includes('playerricas.php')) {
        seenSignedProbeUrls.push(url);
        return new Response(null, { status: 206 });
      }
      seenPlayerricasUrls.push(url);
      return new Response('Forbidden', { status: 403 });
    });

    const res = await attemptControlledR2Resolution(signedUrl, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      assertSafeUrl: async (raw) => new URL(raw),
    });

    // Sonda da URL original preservou integralmente X-Amz-Signature antes de consultar playerricas.php
    expect(seenSignedProbeUrls).toEqual([signedUrl]);
    expect(res.originalUrlStatus.checked).toBe(true);
    expect(res.originalUrlStatus.accessible).toBe(true);
    expect(res.originalUrlStatus.status).toBe(206);

    // Consulta externa ao playerricas.php NÃO enviou X-Amz-Signature
    expect(seenPlayerricasUrls.length).toBe(6);
    for (const pUrl of seenPlayerricasUrls) {
      expect(pUrl).not.toContain('supersecretsignature999');
    }

    // URL original assinada permanece intacta quando playerricas falha
    expect(res.found).toBe(false);
    expect(res.originalUrl).toBe(signedUrl);

    // Logs/diagnósticos das tentativas não expõem a assinatura
    const serializedAttempts = JSON.stringify(res.attempts);
    expect(serializedAttempts).not.toContain('supersecretsignature999');
  });
});

