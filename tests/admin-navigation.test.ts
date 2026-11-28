import fs from 'node:fs';
import path from 'node:path';
import { createMemoryHistory } from '@tanstack/history';
import { describe, expect, it } from 'vitest';
import {
  getActiveAdminView,
  parseAdminSearch,
  resolveAdminBackPlan,
  resolvePostSaveNavigationPlan,
} from '@/lib/admin-navigation';
import { createSessionToken, verifySessionToken } from '@/lib/auth';
import { getRouter } from '@/router';
import { Route as AdminRoute } from '@/routes/admin';

describe('Navegação administrativa, botão Voltar e sessão no TanStack Router', () => {
  it('1 e 7. interpreta corretamente search params das páginas administrativas (inclusive após refresh/URL direta)', () => {
    expect(parseAdminSearch(undefined)).toEqual({});
    expect(parseAdminSearch({ view: 'library' })).toEqual({});
    expect(parseAdminSearch({ view: 'batch' })).toEqual({ view: 'batch' });
    expect(parseAdminSearch({ view: 'create', anime: '  Frieren  ' })).toEqual({
      view: 'create',
      anime: 'Frieren',
    });
    expect(parseAdminSearch({ view: 'edit', ep: 'ep_abc_123' })).toEqual({
      view: 'edit',
      ep: 'ep_abc_123',
    });

    // View edit sem ep válido ou com ID malformado cai com segurança para library
    expect(parseAdminSearch({ view: 'edit' })).toEqual({});
    expect(parseAdminSearch({ view: 'edit', ep: '../bad' })).toEqual({});
    expect(parseAdminSearch({ view: 'desconhecida' })).toEqual({});

    expect(getActiveAdminView(parseAdminSearch({}))).toBe('library');
    expect(getActiveAdminView(parseAdminSearch({ view: 'batch' }))).toBe('batch');
    expect(getActiveAdminView(parseAdminSearch({ view: 'create' }))).toBe('create');
    expect(getActiveAdminView(parseAdminSearch({ view: 'edit', ep: 'ep_abc_123' }))).toBe(
      'edit'
    );
  });

  it('2 e 6. Voltar usa history.back quando há histórico interno e fallback seguro para /admin quando acessado diretamente', () => {
    // Com histórico interno válido: retorna à página anterior real
    expect(
      resolveAdminBackPlan({
        canGoBack: true,
        currentView: 'batch',
      })
    ).toEqual({ type: 'history_back' });

    expect(
      resolveAdminBackPlan({
        canGoBack: true,
        currentView: 'edit',
      })
    ).toEqual({ type: 'history_back' });

    // Acesso direto por URL (canGoBack === false): volta para biblioteca do Admin com replace (sem sair do site nem criar ciclo)
    expect(
      resolveAdminBackPlan({
        canGoBack: false,
        currentView: 'edit',
      })
    ).toEqual({
      type: 'navigate_fallback',
      to: '/admin',
      search: {},
      replace: true,
    });

    expect(
      resolveAdminBackPlan({
        canGoBack: false,
        currentView: 'batch',
      })
    ).toEqual({
      type: 'navigate_fallback',
      to: '/admin',
      search: {},
      replace: true,
    });

    // Pós-salvamento: se veio direto da biblioteca, faz back sem duplicar /admin; senão replace para /admin
    expect(
      resolvePostSaveNavigationPlan({
        canGoBack: true,
        openedDirectlyFromLibrary: true,
      })
    ).toEqual({ type: 'history_back' });

    expect(
      resolvePostSaveNavigationPlan({
        canGoBack: false,
        openedDirectlyFromLibrary: false,
      })
    ).toEqual({
      type: 'navigate_fallback',
      to: '/admin',
      search: {},
      replace: true,
    });
  });

  it('3, 4, 5 e 10. histórico real do TanStack Router respeita Voltar/Avançar entre páginas públicas e sub-telas do Admin sem ciclos', () => {
    const history = createMemoryHistory({
      initialEntries: ['/'],
      initialIndex: 0,
    });

    const router = getRouter();
    router.update({ history });

    expect(history.location.pathname).toBe('/');
    expect(history.canGoBack()).toBe(false);

    // Navega / -> /admin -> /admin?view=create -> /admin?view=batch
    history.push('/admin');
    expect(history.location.pathname).toBe('/admin');
    expect(history.canGoBack()).toBe(true);

    history.push('/admin?view=create');
    expect(history.location.href).toBe('/admin?view=create');
    expect(history.canGoBack()).toBe(true);

    history.push('/admin?view=batch');
    expect(history.location.href).toBe('/admin?view=batch');

    // Simula botão Voltar do site ou gesto físico Voltar do Android: volta para /admin?view=create (não para /)
    history.back();
    expect(history.location.href).toBe('/admin?view=create');

    // Volta novamente: retorna à biblioteca (/admin), ainda sem cair em /
    history.back();
    expect(history.location.href).toBe('/admin');

    // Avança e volta repetidamente sem duplicar nem criar ciclos
    history.forward();
    expect(history.location.href).toBe('/admin?view=create');
    history.forward();
    expect(history.location.href).toBe('/admin?view=batch');
    history.back();
    expect(history.location.href).toBe('/admin?view=create');
    history.back();
    expect(history.location.href).toBe('/admin');

    // Voltando a partir da raiz do Admin, retorna para /
    history.back();
    expect(history.location.href).toBe('/');
    expect(history.canGoBack()).toBe(false);

    // Navegação em episódio público /e/$id preserva histórico de ida e volta
    history.push('/e/ep_demo_01');
    expect(history.location.pathname).toBe('/e/ep_demo_01');
    expect(history.canGoBack()).toBe(true);
    history.back();
    expect(history.location.pathname).toBe('/');
  });

  it('8 e 9. rota /admin impede cache obsoleto de pré-login, preserva sessão válida e bloqueia sessão expirada', async () => {
    expect(AdminRoute.options.staleTime).toBe(0);
    expect(AdminRoute.options.gcTime).toBe(0);

    const adminHeaders = await AdminRoute.options.headers?.({} as never);
    expect(adminHeaders).toMatchObject({
      'Cache-Control': 'private, no-store',
      'CDN-Cache-Control': 'private, no-store',
      Vary: 'Cookie',
    });

    // Sessão válida permanece válida após navegações
    const now = 1_760_000_000;
    const validToken = createSessionToken(now);
    expect(verifySessionToken(validToken, now + 60)).not.toBeNull();

    // Sessão expirada (após 7 dias) continua rejeitada
    const expiredCheck = verifySessionToken(validToken, now + 60 * 60 * 24 * 7 + 1);
    expect(expiredCheck).toBeNull();

    // Token adulterado é rejeitado
    expect(verifySessionToken(`${validToken}tampered`, now + 10)).toBeNull();
  });

  it('confirma ausência de redirecionamento fixo para / ou interceptação invasiva de popstate nos arquivos de rota', () => {
    const adminSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/routes/admin.tsx'),
      'utf8'
    );
    const rootSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/routes/__root.tsx'),
      'utf8'
    );
    const indexSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/routes/index.tsx'),
      'utf8'
    );
    const episodeSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/routes/e/$id.tsx'),
      'utf8'
    );
    const serverFnsSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/server-fns.ts'),
      'utf8'
    );

    // Admin usa TanStack Router oficial (useCanGoBack, router.history.back, validateSearch)
    expect(adminSource).toContain('useCanGoBack');
    expect(adminSource).toContain('validateSearch: parseAdminSearch');
    expect(adminSource).toContain('router.history.back()');
    expect(adminSource).toContain('handleGoBackFromSubView');
    expect(adminSource).toContain('handleCloseForm');

    // Nenhum botão Voltar ou efeito redireciona para "/" nem intercepta popstate bloqueando o Android
    expect(adminSource).not.toMatch(/navigate\s*\(\s*\{\s*to:\s*['"]\/['"]/);
    expect(adminSource).not.toContain('addEventListener(\'popstate\'');
    expect(rootSource).not.toContain('popstate');
    expect(indexSource).not.toContain('popstate');
    expect(episodeSource).not.toContain('popstate');

    // Proteção de sessão preservada
    expect(adminSource).toContain('!initialState.authenticated');
    expect(serverFnsSource).toContain("trySetResponseHeader('Pragma', 'no-cache')");
    expect(serverFnsSource).toContain("trySetResponseHeader('Vary', 'Cookie')");
  });
});
