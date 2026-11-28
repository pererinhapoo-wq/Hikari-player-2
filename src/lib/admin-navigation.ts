export type AdminViewMode = 'library' | 'batch' | 'create' | 'edit';

export interface AdminRouteSearch {
  view?: Exclude<AdminViewMode, 'library'>;
  ep?: string;
  anime?: string;
}

export type AdminBackPlan =
  | { type: 'history_back' }
  | { type: 'navigate_fallback'; to: '/admin'; search: AdminRouteSearch; replace: boolean };

const SAFE_EPISODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function parseAdminSearch(raw: Record<string, unknown> | undefined | null): AdminRouteSearch {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const rawView = typeof raw.view === 'string' ? raw.view.trim() : '';

  if (rawView === 'batch') {
    return { view: 'batch' };
  }

  if (rawView === 'create') {
    const rawAnime = typeof raw.anime === 'string' ? raw.anime.trim().slice(0, 200) : '';
    return rawAnime ? { view: 'create', anime: rawAnime } : { view: 'create' };
  }

  if (rawView === 'edit') {
    const rawEp = typeof raw.ep === 'string' ? raw.ep.trim() : '';
    if (rawEp && SAFE_EPISODE_ID_RE.test(rawEp)) {
      return { view: 'edit', ep: rawEp };
    }
    return {};
  }

  return {};
}

export function getActiveAdminView(search: AdminRouteSearch): AdminViewMode {
  if (search.view === 'batch') return 'batch';
  if (search.view === 'create') return 'create';
  if (search.view === 'edit' && search.ep) return 'edit';
  return 'library';
}

export function resolveAdminBackPlan(options: {
  canGoBack: boolean;
  currentView: AdminViewMode;
}): AdminBackPlan {
  if (options.canGoBack) {
    return { type: 'history_back' };
  }

  return {
    type: 'navigate_fallback',
    to: '/admin',
    search: {},
    replace: options.currentView !== 'library',
  };
}

export function resolvePostSaveNavigationPlan(options: {
  canGoBack: boolean;
  openedDirectlyFromLibrary: boolean;
}): AdminBackPlan {
  if (options.openedDirectlyFromLibrary && options.canGoBack) {
    return { type: 'history_back' };
  }

  return {
    type: 'navigate_fallback',
    to: '/admin',
    search: {},
    replace: true,
  };
}
