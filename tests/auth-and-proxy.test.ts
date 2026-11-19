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
  diagnoseDatabaseConnection,
  type DiagnosticSqlTag,
  inspectDatabaseUrlSafely,
  runDiagnosticWithSql,
  sanitizeDiagnosticError,
} from '@/lib/db';
import {
  buildSignedProxyPath,
  verifyProxySignature,
  rewriteM3u8Playlist,
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

describe('Diagnóstico seguro da variável DATABASE_URL e etapas Neon', () => {
  const originalDbUrl = process.env.DATABASE_URL;
  const originalVercelEnv = process.env.VERCEL_ENV;

  afterEach(() => {
    if (originalDbUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDbUrl;
    }
    if (originalVercelEnv === undefined) {
      delete process.env.VERCEL_ENV;
    } else {
      process.env.VERCEL_ENV = originalVercelEnv;
    }
  });

  it('extrai apenas metadados seguros de URL pooled sem expor usuário, senha, tokens ou URL completa', () => {
    const secretUrl =
      'postgresql://neondb_owner_secret:npg_SecretPass123!@ep-hikari-player-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&pgbouncer=true&secret_tok=abc';
    process.env.VERCEL_ENV = 'production';

    const info = inspectDatabaseUrlSafely(secretUrl);
    expect(info).toEqual({
      configured: true,
      validUrl: true,
      parseError: null,
      hostname: 'ep-hikari-player-123456-pooler.us-east-2.aws.neon.tech',
      database: 'neondb',
      hasUserInUrl: true,
      hasPasswordInUrl: true,
      hasPooling: true,
      vercelEnv: 'production',
      nodeEnv: process.env.NODE_ENV ?? null,
    });

    const serialized = JSON.stringify(info);
    expect(serialized).not.toContain('neondb_owner_secret');
    expect(serialized).not.toContain('npg_SecretPass123!');
    expect(serialized).not.toContain('secret_tok');
    expect(serialized).not.toContain('postgresql://');
  });

  it('sinaliza explicitamente URL incompleta quando só o host está presente', () => {
    const partialUrl = 'postgresql://ep-hikari-player-123456-pooler.us-east-2.aws.neon.tech';
    const info = inspectDatabaseUrlSafely(partialUrl);

    expect(info.configured).toBe(true);
    expect(info.validUrl).toBe(false);
    expect(info.hostname).toBe('ep-hikari-player-123456-pooler.us-east-2.aws.neon.tech');
    expect(info.database).toBeNull();
    expect(info.hasUserInUrl).toBe(false);
    expect(info.parseError).toContain('usuário');
    expect(info.parseError).toContain('nome do banco');
  });

  it('remove credenciais (usuário, senha e URLs completas) caso ocorram em mensagens de erro', () => {
    const secretUrl =
      'postgresql://secret_admin_user:UltraSecret99@ep-test.aws.neon.tech/neondb?sslmode=require';
    const err = Object.assign(
      new Error(
        `Falha ao conectar em ${secretUrl} para usuário secret_admin_user com senha UltraSecret99`
      ),
      { name: 'NeonDbError', code: '28P01' }
    );

    const sanitized = sanitizeDiagnosticError(err, secretUrl);
    expect(sanitized.name).toBe('NeonDbError');
    expect(sanitized.code).toBe('28P01');
    expect(sanitized.message).not.toContain('UltraSecret99');
    expect(sanitized.message).not.toContain('secret_admin_user');
    expect(sanitized.message).not.toContain(secretUrl);
  });

  it('classifica variável ausente sem deixar etapas vazias', async () => {
    delete process.env.DATABASE_URL;
    const result = await diagnoseDatabaseConnection();

    expect(result.diagnosisCode).toBe('env_missing');
    expect(result.env.configured).toBe(false);
    expect(result.connectionEstablished).toBe(false);
    expect(result.diagnosticQueryExecuted).toBe(false);
    expect(result.tableReadExecuted).toBe(false);
    expect(result.connectionError?.name).toBe('DatabaseNotConfiguredError');
  });

  it('classifica falha de conexão quando DATABASE_URL é válida mas o Neon não responde', async () => {
    const url = 'postgresql://u_secret:p_secret@ep-test-pooler.neon.tech/neondb?sslmode=require';
    const env = inspectDatabaseUrlSafely(url);
    const failingSql: DiagnosticSqlTag = async () => {
      throw Object.assign(new Error('Error connecting to database: fetch failed for u_secret p_secret'), {
        name: 'NeonDbError',
      });
    };

    const result = await runDiagnosticWithSql(failingSql, env, '2026-11-19T00:00:00.000Z', url);
    expect(result.diagnosisCode).toBe('connection_failed');
    expect(result.connectionEstablished).toBe(false);
    expect(result.connectionError?.name).toBe('NeonDbError');
    expect(result.connectionError?.message).not.toContain('u_secret');
    expect(result.connectionError?.message).not.toContain('p_secret');
  });

  it('classifica erro de interpretação quando driver retorna formato inesperado', async () => {
    const url = 'postgresql://u_secret:p_secret@ep-test-pooler.neon.tech/neondb';
    const env = inspectDatabaseUrlSafely(url);
    const weirdSql: DiagnosticSqlTag = async () => ({ rows: [] });

    const result = await runDiagnosticWithSql(weirdSql, env, '2026-11-19T00:00:00.000Z', url);
    expect(result.diagnosisCode).toBe('result_interpretation_error');
    expect(result.connectionEstablished).toBe(true);
    expect(result.rawResultShape).toContain('object(rows)');
  });

  it('classifica banco/branch diferente quando public.player_episodes retorna null', async () => {
    const url = 'postgresql://u_secret:p_secret@ep-other-pooler.neon.tech/neondb';
    const env = inspectDatabaseUrlSafely(url);
    const mockSql: DiagnosticSqlTag = async (strings) => {
      const q = strings.join(' ');
      if (q.includes('current_database()')) {
        return [
          {
            current_database: 'neondb',
            current_schema: 'public',
            current_user: 'neondb_owner',
            search_path: '"$user", public',
          },
        ];
      }
      if (q.includes('to_regclass')) {
        return [{ public_table: null, resolved_table: null }];
      }
      throw Object.assign(new Error('relation "public.player_episodes" does not exist'), {
        name: 'NeonDbError',
        code: '42P01',
      });
    };

    const result = await runDiagnosticWithSql(mockSql, env, '2026-11-19T00:00:00.000Z', url);
    expect(result.diagnosisCode).toBe('table_missing_in_public');
    expect(result.connectionEstablished).toBe(true);
    expect(result.diagnosticQueryExecuted).toBe(true);
    expect(result.connection?.public_table).toBeNull();
    expect(result.tableReadError?.code).toBe('42P01');
  });

  it('classifica divergência de search_path quando public.player_episodes existe mas player_episodes falha', async () => {
    const url = 'postgresql://u_secret:p_secret@ep-hikari-pooler.neon.tech/neondb';
    const env = inspectDatabaseUrlSafely(url);
    const mockSql: DiagnosticSqlTag = async (strings) => {
      const q = strings.join(' ');
      if (q.includes('current_database()')) {
        return [
          {
            current_database: 'neondb',
            current_schema: 'custom_schema',
            current_user: 'neondb_owner',
            search_path: 'custom_schema',
          },
        ];
      }
      if (q.includes('to_regclass')) {
        return [{ public_table: 'player_episodes', resolved_table: null }];
      }
      if (q.includes('FROM public.player_episodes')) {
        return [{ episode_count: 3 }];
      }
      throw Object.assign(new Error('relation "player_episodes" does not exist'), {
        name: 'NeonDbError',
        code: '42P01',
      });
    };

    const result = await runDiagnosticWithSql(mockSql, env, '2026-11-19T00:00:00.000Z', url);
    expect(result.diagnosisCode).toBe('search_path_mismatch');
    expect(result.episodeCount).toBe(3);
    expect(result.unqualifiedTableReadOk).toBe(false);
    expect(result.unqualifiedTableReadError?.code).toBe('42P01');
  });

  it('classifica status ok quando conexão e leitura da tabela funcionam normalmente', async () => {
    const url = 'postgresql://u_secret:p_secret@ep-hikari-pooler.neon.tech/neondb';
    const env = inspectDatabaseUrlSafely(url);
    const mockSql: DiagnosticSqlTag = async (strings) => {
      const q = strings.join(' ');
      if (q.includes('current_database()')) {
        return [
          {
            current_database: 'neondb',
            current_schema: 'public',
            current_user: 'neondb_owner',
            search_path: '"$user", public',
          },
        ];
      }
      if (q.includes('to_regclass')) {
        return [{ public_table: 'player_episodes', resolved_table: 'player_episodes' }];
      }
      return [{ episode_count: 5 }];
    };

    const result = await runDiagnosticWithSql(mockSql, env, '2026-11-19T00:00:00.000Z', url);
    expect(result.diagnosisCode).toBe('ok');
    expect(result.connectionEstablished).toBe(true);
    expect(result.diagnosticQueryExecuted).toBe(true);
    expect(result.tableReadExecuted).toBe(true);
    expect(result.episodeCount).toBe(5);
    expect(result.unqualifiedTableReadOk).toBe(true);
  });
});


