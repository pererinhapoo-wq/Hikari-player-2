import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_SESSION_COOKIE_NAME,
  createSessionToken,
  getCanonicalAllowedOrigins,
  isSameOriginPostRequest,
  verifyAdminRequest,
} from '@/lib/auth';
import { handleMirrorRequest } from '@/lib/mirror';
import {
  ServerAuthError,
  validateAdminRequestContext,
  validateMutableServerFnRequest,
} from '@/lib/server-fns';
import { handleThumbnailUploadRequest } from '@/lib/thumbnails';

function makeFakeJpegBytes(length = 1024): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(length));
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xe0;
  return bytes;
}

describe('Proteção CSRF — Validação de Origem Canônica e Endpoints Administrativos', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.PLAYER_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
    process.env.PLAYER_ADMIN_PASSWORD = 'admin-password-test-2026';
    process.env.PLAYER_PUBLIC_BASE_URL = 'https://hikariplayer.cc.cd';
    delete process.env.APP_URL;
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_URL;
    delete process.env.VERCEL_BRANCH_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe('isSameOriginPostRequest e verifyAdminRequest', () => {
    it('aceita POST com Origin igual à origem canônica da aplicação', () => {
      const req = new Request('https://hikariplayer.cc.cd/api/mirror', {
        method: 'POST',
        headers: {
          Origin: 'https://hikariplayer.cc.cd',
          'Sec-Fetch-Site': 'same-origin',
        },
      });
      expect(isSameOriginPostRequest(req)).toBe(true);
    });

    it('rejeita POST com Origin de domínio diferente ou esquema/porta divergente', () => {
      const externalReq = new Request('https://hikariplayer.cc.cd/api/mirror', {
        method: 'POST',
        headers: { Origin: 'https://evil.example' },
      });
      expect(isSameOriginPostRequest(externalReq)).toBe(false);

      const schemeMismatchReq = new Request('https://hikariplayer.cc.cd/api/mirror', {
        method: 'POST',
        headers: { Origin: 'http://hikariplayer.cc.cd' },
      });
      expect(isSameOriginPostRequest(schemeMismatchReq)).toBe(false);

      const subdomainMismatchReq = new Request('https://hikariplayer.cc.cd/api/mirror', {
        method: 'POST',
        headers: { Origin: 'https://sub.hikariplayer.cc.cd' },
      });
      expect(isSameOriginPostRequest(subdomainMismatchReq)).toBe(false);
    });

    it('rejeita POST com Origin "null" ou malformada', () => {
      const nullOriginReq = new Request('https://hikariplayer.cc.cd/api/mirror', {
        method: 'POST',
        headers: { Origin: 'null' },
      });
      expect(isSameOriginPostRequest(nullOriginReq)).toBe(false);

      const malformedOriginReq = new Request('https://hikariplayer.cc.cd/api/mirror', {
        method: 'POST',
        headers: { Origin: 'not-a-valid-origin' },
      });
      expect(isSameOriginPostRequest(malformedOriginReq)).toBe(false);

      const pathInOriginReq = new Request('https://hikariplayer.cc.cd/api/mirror', {
        method: 'POST',
        headers: { Origin: 'https://hikariplayer.cc.cd/admin' },
      });
      expect(isSameOriginPostRequest(pathInOriginReq)).toBe(false);
    });

    it('aceita POST sem Origin quando Referer possui origem válida', () => {
      const req = new Request('https://hikariplayer.cc.cd/api/mirror', {
        method: 'POST',
        headers: {
          Referer: 'https://hikariplayer.cc.cd/admin?view=library',
        },
      });
      expect(isSameOriginPostRequest(req)).toBe(true);
    });

    it('rejeita POST sem Origin quando Referer tem origem externa ou malformada', () => {
      const externalRefReq = new Request('https://hikariplayer.cc.cd/api/mirror', {
        method: 'POST',
        headers: {
          Referer: 'https://attacker.example/csrf.html',
        },
      });
      expect(isSameOriginPostRequest(externalRefReq)).toBe(false);

      const badRefReq = new Request('https://hikariplayer.cc.cd/api/mirror', {
        method: 'POST',
        headers: {
          Referer: 'javascript:alert(1)',
        },
      });
      expect(isSameOriginPostRequest(badRefReq)).toBe(false);
    });

    it('rejeita POST sem Origin e sem Referer', () => {
      const req = new Request('https://hikariplayer.cc.cd/api/mirror', {
        method: 'POST',
      });
      expect(isSameOriginPostRequest(req)).toBe(false);

      const token = createSessionToken();
      const authedReqWithoutOriginOrReferer = new Request('https://hikariplayer.cc.cd/api/mirror', {
        method: 'POST',
        headers: {
          Cookie: `${ADMIN_SESSION_COOKIE_NAME}=${token}`,
        },
      });
      expect(verifyAdminRequest(authedReqWithoutOriginOrReferer)).toEqual({
        authenticated: true,
        sameOrigin: false,
      });
    });

    it('rejeita POST com Sec-Fetch-Site cross-site, same-site ou none', () => {
      for (const value of ['cross-site', 'same-site', 'none']) {
        const req = new Request('https://hikariplayer.cc.cd/api/mirror', {
          method: 'POST',
          headers: {
            Origin: 'https://hikariplayer.cc.cd',
            'Sec-Fetch-Site': value,
          },
        });
        expect(isSameOriginPostRequest(req)).toBe(false);
      }

      const validReq = new Request('https://hikariplayer.cc.cd/api/mirror', {
        method: 'POST',
        headers: {
          Origin: 'https://hikariplayer.cc.cd',
          'Sec-Fetch-Site': 'same-origin',
        },
      });
      expect(isSameOriginPostRequest(validReq)).toBe(true);
    });

    it('não confia em Host ou X-Forwarded-Host fornecidos pelo cliente', () => {
      const spoofedReq = new Request('https://evil.example/api/mirror', {
        method: 'POST',
        headers: {
          Host: 'evil.example',
          'X-Forwarded-Host': 'evil.example',
          'X-Forwarded-Proto': 'https',
          Origin: 'https://evil.example',
        },
      });
      expect(isSameOriginPostRequest(spoofedReq)).toBe(false);
      expect(getCanonicalAllowedOrigins()).toEqual(['https://hikariplayer.cc.cd']);
    });

    it('suporta preview deployments da Vercel sem aceitar origens arbitrárias', () => {
      process.env.VERCEL_ENV = 'preview';
      process.env.VERCEL_URL = 'hikari-git-security.vercel.app';
      const previewReq = new Request('https://hikari-git-security.vercel.app/api/mirror', {
        method: 'POST',
        headers: {
          Origin: 'https://hikari-git-security.vercel.app',
          'Sec-Fetch-Site': 'same-origin',
        },
      });
      expect(isSameOriginPostRequest(previewReq)).toBe(true);

      const evilPreviewReq = new Request('https://hikari-git-security.vercel.app/api/mirror', {
        method: 'POST',
        headers: {
          Origin: 'https://other-preview.vercel.app',
        },
      });
      expect(isSameOriginPostRequest(evilPreviewReq)).toBe(false);
    });
  });

  describe('/api/mirror', () => {
    it('rejeita requisição sem autenticação, com origem externa, sem Origin/Referer ou com Content-Type incompatível', async () => {
      const token = createSessionToken();

      const unauthRes = await handleMirrorRequest(
        new Request('https://hikariplayer.cc.cd/api/mirror', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://hikariplayer.cc.cd',
            'Sec-Fetch-Site': 'same-origin',
          },
          body: JSON.stringify({ episodeId: 'ep1', sourceUrl: 'https://a.r2.cloudflarestorage.com/1.mp4' }),
        })
      );
      expect(unauthRes.status).toBe(401);

      const externalOriginRes = await handleMirrorRequest(
        new Request('https://hikariplayer.cc.cd/api/mirror', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://evil.example',
            Cookie: `${ADMIN_SESSION_COOKIE_NAME}=${token}`,
          },
          body: JSON.stringify({ episodeId: 'ep1', sourceUrl: 'https://a.r2.cloudflarestorage.com/1.mp4' }),
        })
      );
      expect(externalOriginRes.status).toBe(403);

      const missingOriginRes = await handleMirrorRequest(
        new Request('https://hikariplayer.cc.cd/api/mirror', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `${ADMIN_SESSION_COOKIE_NAME}=${token}`,
          },
          body: JSON.stringify({ episodeId: 'ep1', sourceUrl: 'https://a.r2.cloudflarestorage.com/1.mp4' }),
        })
      );
      expect(missingOriginRes.status).toBe(403);

      const formEncodedRes = await handleMirrorRequest(
        new Request('https://hikariplayer.cc.cd/api/mirror', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: 'https://hikariplayer.cc.cd',
            'Sec-Fetch-Site': 'same-origin',
            Cookie: `${ADMIN_SESSION_COOKIE_NAME}=${token}`,
          },
          body: 'episodeId=ep1',
        })
      );
      expect(formEncodedRes.status).toBe(415);
    });

    it('aceita requisição legítima autenticada com origem canônica e application/json', async () => {
      const token = createSessionToken();
      const res = await handleMirrorRequest(
        new Request('https://hikariplayer.cc.cd/api/mirror', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Origin: 'https://hikariplayer.cc.cd',
            'Sec-Fetch-Site': 'same-origin',
            Cookie: `${ADMIN_SESSION_COOKIE_NAME}=${token}`,
          },
          body: JSON.stringify({ episodeId: '', sourceUrl: '' }),
        }),
        {
          isDbConfigured: () => true,
          blobToken: 'vercel_blob_rw_test_token',
        }
      );
      // Passa CSRF (403) e Auth (401) e Content-Type (415) e chega à validação do payload (400)
      expect(res.status).toBe(400);
    });
  });

  describe('/api/thumbnails', () => {
    it('rejeita requisição com origem externa, sem Origin/Referer, sem autenticação ou Content-Type não multipart', async () => {
      const token = createSessionToken();
      const form = new FormData();
      form.append('file', new Blob([makeFakeJpegBytes()], { type: 'image/jpeg' }), 'thumb.jpg');

      const externalRes = await handleThumbnailUploadRequest(
        new Request('https://hikariplayer.cc.cd/api/thumbnails', {
          method: 'POST',
          headers: {
            Origin: 'https://evil.example',
            Cookie: `${ADMIN_SESSION_COOKIE_NAME}=${token}`,
          },
          body: form,
        })
      );
      expect(externalRes.status).toBe(403);

      const missingOriginRes = await handleThumbnailUploadRequest(
        new Request('https://hikariplayer.cc.cd/api/thumbnails', {
          method: 'POST',
          headers: {
            Cookie: `${ADMIN_SESSION_COOKIE_NAME}=${token}`,
          },
          body: form,
        })
      );
      expect(missingOriginRes.status).toBe(403);

      const unauthRes = await handleThumbnailUploadRequest(
        new Request('https://hikariplayer.cc.cd/api/thumbnails', {
          method: 'POST',
          headers: {
            Origin: 'https://hikariplayer.cc.cd',
            'Sec-Fetch-Site': 'same-origin',
          },
          body: form,
        })
      );
      expect(unauthRes.status).toBe(401);

      const jsonBodyRes = await handleThumbnailUploadRequest(
        new Request('https://hikariplayer.cc.cd/api/thumbnails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://hikariplayer.cc.cd',
            'Sec-Fetch-Site': 'same-origin',
            Cookie: `${ADMIN_SESSION_COOKIE_NAME}=${token}`,
          },
          body: JSON.stringify({ file: 'x' }),
        })
      );
      expect(jsonBodyRes.status).toBe(415);
    });

    it('aceita upload multipart legítimo autenticado com origem canônica sem mock de verifyAdmin', async () => {
      const token = createSessionToken();
      const form = new FormData();
      form.append('file', new Blob([makeFakeJpegBytes(1536)], { type: 'image/jpeg' }), 'thumb.jpg');
      form.append('animeName', 'Frieren');
      form.append('episodeId', 'ep-01');

      const putBlob = vi.fn(async (pathname: string) => ({
        url: `https://store.public.blob.vercel-storage.com/${pathname}`,
        downloadUrl: `https://store.public.blob.vercel-storage.com/${pathname}`,
        pathname,
        contentType: 'image/jpeg',
        contentDisposition: 'inline',
        etag: 'etag-ok',
      }));

      const res = await handleThumbnailUploadRequest(
        new Request('https://hikariplayer.cc.cd/api/thumbnails', {
          method: 'POST',
          headers: {
            Origin: 'https://hikariplayer.cc.cd',
            'Sec-Fetch-Site': 'same-origin',
            Cookie: `${ADMIN_SESSION_COOKIE_NAME}=${token}`,
          },
          body: form,
        }),
        {
          blobToken: 'vercel_blob_rw_test',
          putBlob: putBlob as never,
        }
      );

      expect(res.status).toBe(200);
      expect(putBlob).toHaveBeenCalledTimes(1);
    });
  });

  describe('Server Functions Administrativas (mutações vs GET e login/logout)', () => {
    it('rejeita mutação sem sessão mesmo com origem válida (401)', () => {
      const validOriginPost = new Request('https://hikariplayer.cc.cd/_serverFn/adminCreateEpisodeFn', {
        method: 'POST',
        headers: {
          Origin: 'https://hikariplayer.cc.cd',
          'Sec-Fetch-Site': 'same-origin',
          'Content-Type': 'application/json',
        },
        body: '{}',
      });

      expect(() =>
        validateAdminRequestContext({ request: validOriginPost, token: null })
      ).toThrowError(ServerAuthError);

      try {
        validateAdminRequestContext({ request: validOriginPost, token: null });
      } catch (err) {
        expect((err as ServerAuthError).status).toBe(401);
      }
    });

    it('rejeita mutação autenticada com origem externa, Origin null ou sem Origin/Referer (403)', () => {
      const token = createSessionToken();

      const externalReq = new Request('https://hikariplayer.cc.cd/_serverFn/adminDeleteEpisodeFn', {
        method: 'POST',
        headers: {
          Origin: 'https://evil.example',
          'Content-Type': 'application/json',
        },
        body: '{}',
      });

      const missingOriginReq = new Request('https://hikariplayer.cc.cd/_serverFn/adminDeleteEpisodeFn', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: '{}',
      });

      const crossSiteSecFetchReq = new Request('https://hikariplayer.cc.cd/_serverFn/adminDeleteEpisodeFn', {
        method: 'POST',
        headers: {
          Origin: 'https://hikariplayer.cc.cd',
          'Sec-Fetch-Site': 'cross-site',
          'Content-Type': 'application/json',
        },
        body: '{}',
      });

      for (const req of [externalReq, missingOriginReq, crossSiteSecFetchReq]) {
        try {
          validateAdminRequestContext({ request: req, token });
          expect.unreachable('Deveria rejeitar mutação CSRF');
        } catch (err) {
          expect(err).toBeInstanceOf(ServerAuthError);
          expect((err as ServerAuthError).status).toBe(403);
        }
      }
    });

    it('aceita mutação autenticada com origem válida e Content-Type JSON ou chamada POST sem corpo (ex: logout/diagnose)', () => {
      const token = createSessionToken();

      const jsonMutationReq = new Request('https://hikariplayer.cc.cd/_serverFn/adminUpdateEpisodeFn', {
        method: 'POST',
        headers: {
          Origin: 'https://hikariplayer.cc.cd',
          'Sec-Fetch-Site': 'same-origin',
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      expect(() => validateAdminRequestContext({ request: jsonMutationReq, token })).not.toThrow();

      // TanStack Start envia POST sem Content-Type quando o RPC não recebe argumentos (ex: adminDiagnoseDatabaseFn / adminClearPlaybackDiagnosticsFn)
      const zeroArgMutationReq = new Request('https://hikariplayer.cc.cd/_serverFn/adminDiagnoseDatabaseFn', {
        method: 'POST',
        headers: {
          Origin: 'https://hikariplayer.cc.cd',
          'Sec-Fetch-Site': 'same-origin',
        },
      });
      expect(() => validateAdminRequestContext({ request: zeroArgMutationReq, token })).not.toThrow();
    });

    it('preserva operações GET legítimas sem Origin quando autenticadas', () => {
      const token = createSessionToken();
      const getReq = new Request('https://hikariplayer.cc.cd/_serverFn/adminGetPlaybackDiagnosticsFn', {
        method: 'GET',
      });

      expect(() => validateAdminRequestContext({ request: getReq, token })).not.toThrow();
      expect(() => validateAdminRequestContext({ request: getReq, token: null })).toThrowError(
        ServerAuthError
      );
    });

    it('valida origem em adminLoginFn e adminLogoutFn contra CSRF mantendo fluxo legítimo', () => {
      const validLoginReq = new Request('https://hikariplayer.cc.cd/_serverFn/adminLoginFn', {
        method: 'POST',
        headers: {
          Origin: 'https://hikariplayer.cc.cd',
          'Sec-Fetch-Site': 'same-origin',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ data: { password: 'secret' } }),
      });
      expect(() => validateMutableServerFnRequest(validLoginReq)).not.toThrow();

      const validLogoutReq = new Request('https://hikariplayer.cc.cd/_serverFn/adminLogoutFn', {
        method: 'POST',
        headers: {
          Origin: 'https://hikariplayer.cc.cd',
          'Sec-Fetch-Site': 'same-origin',
        },
      });
      expect(() => validateMutableServerFnRequest(validLogoutReq)).not.toThrow();

      const csrfLoginReq = new Request('https://hikariplayer.cc.cd/_serverFn/adminLoginFn', {
        method: 'POST',
        headers: {
          Origin: 'https://attacker.example',
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      expect(() => validateMutableServerFnRequest(csrfLoginReq)).toThrowError(ServerAuthError);

      const csrfLogoutFormReq = new Request('https://hikariplayer.cc.cd/_serverFn/adminLogoutFn', {
        method: 'POST',
        headers: {
          Origin: 'https://hikariplayer.cc.cd',
          'Sec-Fetch-Site': 'same-origin',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'x=1',
      });
      try {
        validateMutableServerFnRequest(csrfLogoutFormReq);
        expect.unreachable('Deveria rejeitar Content-Type application/x-www-form-urlencoded');
      } catch (err) {
        expect(err).toBeInstanceOf(ServerAuthError);
        expect((err as ServerAuthError).status).toBe(415);
      }
    });

    it('garante que todas as Server Functions mutáveis em server-fns.ts aplicam requireAdminSession() ou requireSameOriginMutationRequest()', () => {
      const source = fs.readFileSync(
        path.resolve(process.cwd(), 'src/lib/server-fns.ts'),
        'utf8'
      );

      expect(source).toMatch(/adminLoginFn[\s\S]*?requireSameOriginMutationRequest\(\)/);
      expect(source).toMatch(/adminLogoutFn[\s\S]*?requireSameOriginMutationRequest\(\)/);

      const protectedMutations = [
        'adminCreateEpisodeFn',
        'adminUpdateEpisodeFn',
        'adminDeleteEpisodeFn',
        'adminDuplicateEpisodeFn',
        'adminDiagnoseDatabaseFn',
        'adminTestSourceFn',
        'adminTestEpisodeSourcesFn',
        'adminProcessBatchItemFn',
        'adminResolveThumbnailSourceFn',
        'adminResolveR2SourceFn',
        'adminClearPlaybackDiagnosticsFn',
      ];

      for (const fnName of protectedMutations) {
        const pattern = new RegExp(`${fnName}[\\s\\S]*?requireAdminSession\\(\\)`);
        expect(source, `${fnName} deve exigir requireAdminSession()`).toMatch(pattern);
      }
    });
  });
});
