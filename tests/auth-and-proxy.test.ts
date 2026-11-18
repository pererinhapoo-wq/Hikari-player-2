import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildPublicEpisodeUrl,
  checkLoginRateLimit,
  clearLoginAttempts,
  createSessionToken,
  recordFailedLogin,
  verifyAdminPassword,
  verifySessionToken,
} from '@/lib/auth';
import {
  buildSignedProxyPath,
  rewriteM3u8Playlist,
  verifyProxySignature,
} from '@/lib/proxy-signing';
import { assertSafeExternalUrl, isPrivateOrReservedIp } from '@/lib/ssrf';

describe('Autenticação administrativa e URL pública canônica', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.PLAYER_ADMIN_PASSWORD = 'super-secret-admin-password-2026';
    process.env.PLAYER_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
    process.env.PLAYER_PUBLIC_BASE_URL = 'https://player.exemplo.com/';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('verifica a senha administrativa em tempo constante', () => {
    expect(verifyAdminPassword('super-secret-admin-password-2026')).toBe(true);
    expect(verifyAdminPassword('senha-errada')).toBe(false);
    expect(verifyAdminPassword('')).toBe(false);
  });

  it('gera e valida token de sessão assinado e rejeita adulteração ou expiração', () => {
    const now = 1_700_000_000;
    const token = createSessionToken(now);

    const valid = verifySessionToken(token, now + 60);
    expect(valid?.sub).toBe('admin');

    // Token adulterado
    const [payload, sig] = token.split('.');
    const tampered = `${payload}.${sig.slice(0, -2)}AA`;
    expect(verifySessionToken(tampered, now + 60)).toBeNull();

    // Token expirado (> 7 dias)
    expect(verifySessionToken(token, now + 60 * 60 * 24 * 8)).toBeNull();
  });

  it('aplica rate limit após múltiplas tentativas falhas e limpa após sucesso', () => {
    const key = '203.0.113.42';
    clearLoginAttempts(key);
    for (let i = 0; i < 8; i++) {
      expect(checkLoginRateLimit(key).allowed).toBe(true);
      recordFailedLogin(key);
    }
    const blocked = checkLoginRateLimit(key);
    expect(blocked.allowed).toBe(false);
    expect((blocked.retryAfterSeconds ?? 0) > 0).toBe(true);

    clearLoginAttempts(key);
    expect(checkLoginRateLimit(key).allowed).toBe(true);
  });

  it('gera link público usando PLAYER_PUBLIC_BASE_URL sem confiar em Host arbitrário', () => {
    expect(buildPublicEpisodeUrl('abc123XYZ')).toBe('https://player.exemplo.com/e/abc123XYZ');
  });
});

describe('Segurança de Proxy, SSRF e Reescrita M3U8', () => {
  beforeEach(() => {
    process.env.PLAYER_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
  });

  it('bloqueia IPs privados, loopback, metadata e destinos locais contra SSRF', async () => {
    expect(isPrivateOrReservedIp('127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('10.0.0.5')).toBe(true);
    expect(isPrivateOrReservedIp('172.16.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('192.168.1.10')).toBe(true);
    expect(isPrivateOrReservedIp('169.254.169.254')).toBe(true);
    expect(isPrivateOrReservedIp('::1')).toBe(true);
    expect(isPrivateOrReservedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('8.8.8.8')).toBe(false);

    await expect(assertSafeExternalUrl('http://localhost:3000/secret')).rejects.toThrow();
    await expect(assertSafeExternalUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow();
    await expect(assertSafeExternalUrl('http://127.0.0.1:8080/')).rejects.toThrow();
  });

  it('assina e valida URLs de proxy para impedir uso como proxy aberto', () => {
    const target = 'https://cdn.maximaimg.online/hls/ep1/master.m3u8';
    const path = buildSignedProxyPath(target, 600);
    const parsed = new URL(`http://localhost${path}`);

    expect(
      verifyProxySignature(
        parsed.searchParams.get('url') ?? '',
        parsed.searchParams.get('exp'),
        parsed.searchParams.get('sig')
      )
    ).toBe(true);

    // Tentativa de trocar o destino mantém assinatura inválida
    expect(
      verifyProxySignature(
        'https://evil.example.com/steal',
        parsed.searchParams.get('exp'),
        parsed.searchParams.get('sig')
      )
    ).toBe(false);
  });

  it('reescreve playlists M3U8 (segmentos relativos, absolutos, chaves e mapas)', () => {
    const rawM3u8 = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-KEY:METHOD=AES-128,URI="keys/enc.key"',
      '#EXT-X-MAP:URI="/init/header.mp4"',
      '#EXTINF:6.0,',
      'seg-001.ts',
      '#EXTINF:6.0,',
      'https://edge.maximaimg.online/seg-002.ts?tok=1',
      '#EXT-X-ENDLIST',
    ].join('\n');

    const rewritten = rewriteM3u8Playlist(
      rawM3u8,
      'https://cdn.maximaimg.online/hls/ep1/index.m3u8',
      (resolved) => `/api/proxy/stream?url=${encodeURIComponent(resolved)}`
    );

    expect(rewritten).toContain(
      '#EXT-X-KEY:METHOD=AES-128,URI="/api/proxy/stream?url=https%3A%2F%2Fcdn.maximaimg.online%2Fhls%2Fep1%2Fkeys%2Fenc.key"'
    );
    expect(rewritten).toContain(
      '#EXT-X-MAP:URI="/api/proxy/stream?url=https%3A%2F%2Fcdn.maximaimg.online%2Finit%2Fheader.mp4"'
    );
    expect(rewritten).toContain(
      '/api/proxy/stream?url=https%3A%2F%2Fcdn.maximaimg.online%2Fhls%2Fep1%2Fseg-001.ts'
    );
    expect(rewritten).toContain(
      '/api/proxy/stream?url=https%3A%2F%2Fedge.maximaimg.online%2Fseg-002.ts%3Ftok%3D1'
    );
  });
});
