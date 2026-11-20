import { createFileRoute, useRouter } from '@tanstack/react-router';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  Film,
  FolderOpen,
  LogOut,
  MoreVertical,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AnimeGroup,
  type AnimeSortMode,
  countEpisodeSources,
  filterAndSortAnimeGroups,
  formatEpisodeDisplayTitle,
  groupEpisodesByAnime,
  normalizeAnimeKey,
  sanitizeAnimeName,
  UNASSIGNED_ANIME_KEY,
} from '@/lib/anime-library';
import { getOptimizedImageProps } from '@/lib/image-optimization';
import { formatOpeningTimestamp, parseOpeningRange } from '@/lib/opening-skip';
import {
  adminCreateEpisodeFn,
  adminDeleteEpisodeFn,
  adminDiagnoseDatabaseFn,
  adminLoginFn,
  adminLogoutFn,
  adminTestSourceFn,
  adminUpdateEpisodeFn,
  getAdminDashboardFn,
} from '@/lib/server-fns';
import type {
  DatabaseDiagnosticResult,
  EpisodeDto,
  SourceTestReport,
} from '@/lib/types';
import {
  classifyEmbedHost,
  detectSourceKind,
  EMBED_DIRECT_HOSTS,
  EMBED_PROXIED_HOSTS,
  type ExplicitSourceKind,
  normalizeVideoSource,
  validateHttpUrl,
} from '@/lib/video-sources';

export const Route = createFileRoute('/admin')({
  loader: async () => {
    return await getAdminDashboardFn();
  },
  headers: () => ({
    'Cache-Control': 'private, no-store',
    'CDN-Cache-Control': 'private, no-store',
  }),
  head: () => ({
    meta: [{ title: 'Administração · Player' }],
  }),
  component: AdminPage,
});

interface SinglePlayerFormState {
  anime_name: string;
  episode_number: string;
  title: string;
  opening_start: string;
  opening_end: string;
  poster_url: string;
  video_url: string;
  source_kind: ExplicitSourceKind | '';
}

const EMPTY_FORM: SinglePlayerFormState = {
  anime_name: '',
  episode_number: '',
  title: '',
  opening_start: '',
  opening_end: '',
  poster_url: '',
  video_url: '',
  source_kind: '',
};

function formatDatePtBr(iso: string): string {
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function AnimeThumbnail({
  posterUrl,
  alt,
  className = 'w-20 h-14',
}: {
  posterUrl: string | null;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [posterUrl]);

  if (!posterUrl || failed) {
    return (
      <div
        className={`${className} rounded-lg bg-[#090B10] border border-white/10 flex items-center justify-center shrink-0`}
      >
        <Film className="w-5 h-5 text-slate-600" />
      </div>
    );
  }

  const imgProps = getOptimizedImageProps(posterUrl, 'miniatura');

  return (
    <div
      className={`${className} rounded-lg overflow-hidden bg-[#090B10] border border-white/10 shrink-0`}
    >
      <img
        {...imgProps}
        alt={alt}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="w-full h-full object-cover"
      />
    </div>
  );
}

function AdminPage() {
  const router = useRouter();
  const initialState = Route.useLoaderData();

  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);

  // Navigation & library filtering state
  const [selectedAnimeKey, setSelectedAnimeKey] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<AnimeSortMode>('recent');

  // Form modal/panel state (single player only)
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<SinglePlayerFormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [posterPreviewError, setPosterPreviewError] = useState(false);

  const [savedBanner, setSavedBanner] = useState<{
    label: string;
    publicUrl: string;
    action: 'created' | 'updated';
  } | null>(null);

  // Episode actions state
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Source diagnostics (form Player 1 + episode list)
  const [slotTesting, setSlotTesting] = useState(false);
  const [slotReport, setSlotReport] = useState<SourceTestReport | null>(null);
  const [slotTestError, setSlotTestError] = useState<string | null>(null);

  const [episodeTests, setEpisodeTests] = useState<Record<string, SourceTestReport[]>>({});
  const [episodeTestingId, setEpisodeTestingId] = useState<string | null>(null);
  const [episodeTestErrors, setEpisodeTestErrors] = useState<Record<string, string>>({});

  // Neon DB diagnostic state
  const [showDiagnostic, setShowDiagnostic] = useState(false);
  const [diagnostic, setDiagnostic] = useState<DatabaseDiagnosticResult | null>(null);
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);

  const menuContainerRef = useRef<HTMLDivElement | null>(null);

  // Close three-dots menu when clicking outside or pressing Escape
  useEffect(() => {
    if (!openMenuId) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-episode-menu-root="true"]')) {
        return;
      }
      setOpenMenuId(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenMenuId(null);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [openMenuId]);

  const animeGroups = useMemo(
    () => groupEpisodesByAnime(initialState.episodes),
    [initialState.episodes]
  );

  const filteredGroups = useMemo(
    () => filterAndSortAnimeGroups(animeGroups, searchQuery, sortBy),
    [animeGroups, searchQuery, sortBy]
  );

  const selectedGroup: AnimeGroup | null = useMemo(() => {
    if (!selectedAnimeKey) return null;
    return animeGroups.find((g) => g.key === selectedAnimeKey) ?? null;
  }, [animeGroups, selectedAnimeKey]);

  const identifiedAnimeCount = useMemo(
    () => animeGroups.filter((g) => !g.isUnassigned).length,
    [animeGroups]
  );

  const existingAnimeNames = useMemo(
    () =>
      animeGroups
        .filter((g) => !g.isUnassigned)
        .map((g) => g.name)
        .sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' })),
    [animeGroups]
  );

  // If the selected anime becomes empty (e.g., last episode deleted/moved), return cleanly to library
  useEffect(() => {
    if (selectedAnimeKey && !selectedGroup && !formOpen) {
      setSelectedAnimeKey(null);
    }
  }, [selectedAnimeKey, selectedGroup, formOpen]);

  const runDiagnostic = async () => {
    setShowDiagnostic(true);
    setDiagnosticBusy(true);
    setDiagnosticError(null);
    try {
      const res = await adminDiagnoseDatabaseFn();
      if (!res.ok) {
        setDiagnosticError(res.error);
        setDiagnostic(null);
        return;
      }
      setDiagnostic(res.diagnostic);
    } catch (err) {
      setDiagnosticError(
        err instanceof Error ? err.message : 'Falha ao executar diagnóstico do Neon.'
      );
      setDiagnostic(null);
    } finally {
      setDiagnosticBusy(false);
    }
  };

  useEffect(() => {
    if (initialState.authenticated && initialState.errorMessage) {
      void runDiagnostic();
    }
  }, [initialState.authenticated, initialState.errorMessage]);

  const posterValidation = useMemo(() => {
    if (!form.poster_url.trim()) return null;
    return validateHttpUrl(form.poster_url);
  }, [form.poster_url]);

  const primarySourceInfo = useMemo(() => {
    const trimmed = form.video_url.trim();
    if (!trimmed) return null;
    const check = validateHttpUrl(trimmed);
    const normalized = normalizeVideoSource(trimmed, 1, form.source_kind || null);
    const detectedKind = detectSourceKind(trimmed, form.source_kind || null);
    const embedHostMode = classifyEmbedHost(check.normalizedUrl ?? trimmed);
    return { trimmed, check, normalized, detectedKind, embedHostMode };
  }, [form.video_url, form.source_kind]);

  const copyLink = async (id: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(id);
      window.setTimeout(() => {
        setCopiedId((current) => (current === id ? null : current));
      }, 2000);
    } catch {
      // Fallback ignored in restricted clipboard contexts
    }
  };

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    setLoginBusy(true);
    try {
      const res = await adminLoginFn({ data: { password } });
      if (!res.ok) {
        setLoginError(res.error ?? 'Falha ao autenticar.');
        return;
      }
      setPassword('');
      await router.invalidate();
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Erro ao validar senha.');
    } finally {
      setLoginBusy(false);
    }
  };

  const handleLogout = async () => {
    await adminLogoutFn();
    setFormOpen(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setSelectedAnimeKey(null);
    setSearchQuery('');
    setSavedBanner(null);
    setShowDiagnostic(false);
    setDiagnostic(null);
    setDiagnosticError(null);
    await router.invalidate();
  };

  const resetFormTestState = () => {
    setFormError(null);
    setPosterPreviewError(false);
    setSlotTesting(false);
    setSlotReport(null);
    setSlotTestError(null);
  };

  const handleOpenCreateForm = (prefillAnimeName?: string) => {
    setEditingId(null);
    setForm({
      ...EMPTY_FORM,
      anime_name: prefillAnimeName ?? '',
    });
    resetFormTestState();
    setOpenMenuId(null);
    setConfirmDeleteId(null);
    setFormOpen(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleEditStart = (ep: EpisodeDto) => {
    setEditingId(ep.id);
    setForm({
      anime_name: ep.anime_name ?? '',
      episode_number: ep.episode_number ?? '',
      title: ep.title ?? '',
      opening_start: formatOpeningTimestamp(ep.opening_start_seconds),
      opening_end: formatOpeningTimestamp(ep.opening_end_seconds),
      poster_url: ep.poster_url,
      video_url: ep.video_url,
      source_kind: ep.source_kind ?? '',
    });
    resetFormTestState();
    setOpenMenuId(null);
    setConfirmDeleteId(null);
    setFormOpen(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleCloseForm = () => {
    setFormOpen(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    resetFormTestState();
  };

  const handleTestFormPrimarySource = async () => {
    const trimmed = form.video_url.trim();
    if (!trimmed) return;
    setSlotTesting(true);
    setSlotTestError(null);
    try {
      const res = await adminTestSourceFn({
        data: {
          slot: 1,
          label: 'Player 1',
          url: trimmed,
          kind: form.source_kind,
        },
      });
      if (!res.ok) {
        setSlotTestError(res.error);
        setSlotReport(null);
      } else {
        setSlotReport(res.report);
      }
    } catch (err) {
      setSlotTestError(err instanceof Error ? err.message : 'Falha ao testar fonte.');
      setSlotReport(null);
    } finally {
      setSlotTesting(false);
    }
  };

  const handleTestEpisodeSources = async (ep: EpisodeDto) => {
    if (!ep.video_url?.trim()) return;

    setOpenMenuId(null);
    setEpisodeTestingId(ep.id);
    setEpisodeTestErrors((prev) => {
      const next = { ...prev };
      delete next[ep.id];
      return next;
    });
    try {
      const res = await adminTestSourceFn({
        data: {
          slot: 1,
          label: 'Player 1',
          url: ep.video_url,
          kind: (ep.source_kind ?? '') as ExplicitSourceKind | '',
        },
      });
      if (!res.ok) {
        setEpisodeTestErrors((prev) => ({ ...prev, [ep.id]: res.error }));
      } else {
        setEpisodeTests((prev) => ({ ...prev, [ep.id]: [res.report] }));
      }
    } catch (err) {
      setEpisodeTestErrors((prev) => ({
        ...prev,
        [ep.id]: err instanceof Error ? err.message : 'Falha ao testar fonte.',
      }));
    } finally {
      setEpisodeTestingId(null);
    }
  };

  const handleSaveEpisode = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);

    let openingRange: { opening_start_seconds: number | null; opening_end_seconds: number | null };
    try {
      openingRange = parseOpeningRange(form.opening_start, form.opening_end);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Horários da opening inválidos.');
      return;
    }

    setSaveBusy(true);

    const payload = {
      anime_name: sanitizeAnimeName(form.anime_name),
      episode_number: form.episode_number.trim() || null,
      opening_start_seconds: openingRange.opening_start_seconds,
      opening_end_seconds: openingRange.opening_end_seconds,
      title: form.title.trim(),
      poster_url: form.poster_url.trim(),
      video_url: form.video_url.trim(),
      source_kind: form.source_kind,
    };

    try {
      if (editingId) {
        const res = await adminUpdateEpisodeFn({
          data: { id: editingId, ...payload },
        });
        if (!res.ok) {
          setFormError(res.error);
          return;
        }
        setSavedBanner({
          label: formatEpisodeDisplayTitle(res.episode),
          publicUrl: res.episode.public_url,
          action: 'updated',
        });
        setSelectedAnimeKey(normalizeAnimeKey(res.episode.anime_name));
        setEditingId(null);
        setForm(EMPTY_FORM);
        setFormOpen(false);
      } else {
        const res = await adminCreateEpisodeFn({ data: payload });
        if (!res.ok) {
          setFormError(res.error);
          return;
        }
        setSavedBanner({
          label: formatEpisodeDisplayTitle(res.episode),
          publicUrl: res.episode.public_url,
          action: 'created',
        });
        setSelectedAnimeKey(normalizeAnimeKey(res.episode.anime_name));
        setForm(EMPTY_FORM);
        setFormOpen(false);
      }
      resetFormTestState();
      await router.invalidate();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Erro ao salvar episódio.');
    } finally {
      setSaveBusy(false);
    }
  };

  const handleConfirmDelete = async (id: string) => {
    setDeleteBusyId(id);
    setActionError(null);
    try {
      const res = await adminDeleteEpisodeFn({ data: { id } });
      if (!res.ok) {
        setActionError(res.error);
      } else {
        if (editingId === id) {
          handleCloseForm();
        }
        setConfirmDeleteId(null);
        await router.invalidate();
      }
    } finally {
      setDeleteBusyId(null);
    }
  };

  const missingEnvItems: string[] = [];
  if (!initialState.databaseConfigured) missingEnvItems.push('DATABASE_URL');
  if (!initialState.passwordConfigured) missingEnvItems.push('PLAYER_ADMIN_PASSWORD');
  if (!initialState.secretConfigured) missingEnvItems.push('PLAYER_SESSION_SECRET');

  return (
    <div className="min-h-screen bg-[#090B10] text-slate-100">
      {/* Header */}
      <header className="border-b border-white/10 bg-[#0D1018]">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-14 sm:h-16 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="text-base sm:text-lg font-semibold tracking-tight text-white whitespace-nowrap shrink-0">
              Player
            </span>
            <span className="text-slate-600 hidden sm:inline" aria-hidden="true">
              /
            </span>
            <span className="text-xs sm:text-sm text-slate-400 hidden sm:inline truncate">
              Administração
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {initialState.authenticated ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    if (showDiagnostic && !diagnosticBusy) {
                      setShowDiagnostic(false);
                    } else {
                      void runDiagnostic();
                    }
                  }}
                  disabled={diagnosticBusy}
                  className="h-9 px-2.5 sm:px-3 rounded-lg border border-white/10 text-xs font-medium text-slate-300 hover:bg-white/5 hover:text-white disabled:opacity-50 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                  title="Diagnóstico da conexão Neon"
                >
                  <Database className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">
                    {diagnosticBusy ? 'Diagnosticando...' : 'Diagnóstico Neon'}
                  </span>
                  <span className="sm:hidden">Neon</span>
                </button>

                <button
                  type="button"
                  onClick={handleLogout}
                  className="h-9 px-2.5 sm:px-3 rounded-lg border border-white/10 text-xs font-medium text-slate-200 hover:bg-white/5 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Sair
                </button>
              </>
            ) : (
              <span className="text-xs text-slate-400 whitespace-nowrap">
                Área restrita
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-5 sm:py-8 space-y-5">
        {/* Pending environment setup notice */}
        {missingEnvItems.length > 0 && (
          <section className="bg-[#11151E] border border-amber-500/30 rounded-xl p-4 sm:p-5">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div className="space-y-1.5 text-sm">
                <h2 className="font-semibold text-white">
                  Configuração de ambiente pendente
                </h2>
                <p className="text-slate-300 text-xs sm:text-sm leading-relaxed">
                  Defina as variáveis de ambiente no servidor e aplique as migrations em{' '}
                  <code className="font-mono text-xs bg-white/5 px-1.5 py-0.5 rounded">
                    migrations/
                  </code>{' '}
                  no seu banco Neon:{' '}
                  <span className="font-mono text-xs text-amber-300">
                    {missingEnvItems.join(' · ')}
                  </span>
                </p>
              </div>
            </div>
          </section>
        )}

        {/* Unauthenticated login form */}
        {!initialState.authenticated ? (
          <section className="max-w-md mx-auto pt-6 sm:pt-10">
            <form
              onSubmit={handleLogin}
              className="bg-[#11151E] border border-white/10 rounded-xl p-6 sm:p-7 space-y-5"
            >
              <div>
                <h1 className="text-xl font-semibold text-white">
                  Acesso administrativo
                </h1>
                <p className="mt-1 text-sm text-slate-400">
                  Informe a senha definida em{' '}
                  <code className="font-mono text-xs text-slate-300">
                    PLAYER_ADMIN_PASSWORD
                  </code>{' '}
                  para gerenciar episódios.
                </p>
              </div>

              <div>
                <label
                  htmlFor="admin-password"
                  className="block text-xs font-medium text-slate-300 mb-1.5"
                >
                  Senha administrativa
                </label>
                <div className="relative">
                  <input
                    id="admin-password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Digite a senha do painel"
                    className="w-full h-11 px-3.5 pr-11 rounded-lg bg-[#090B10] border border-white/15 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-slate-400 hover:text-white cursor-pointer"
                  >
                    {showPassword ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>

              {loginError && (
                <p className="text-sm text-rose-400" role="alert">
                  {loginError}
                </p>
              )}

              <button
                type="submit"
                disabled={loginBusy}
                className="w-full h-11 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-60 text-sm font-medium text-white transition-colors cursor-pointer"
              >
                {loginBusy ? 'Entrando...' : 'Entrar'}
              </button>
            </form>
          </section>
        ) : (
          /* Authenticated Admin Workspace */
          <div className="space-y-5">
            {/* Database read error */}
            {initialState.errorMessage && (
              <div className="rounded-xl border border-rose-500/30 bg-rose-950/30 px-4 py-3.5 text-xs sm:text-sm text-rose-300">
                {initialState.errorMessage}
              </div>
            )}

            {/* Collapsible Neon diagnostic panel */}
            {showDiagnostic && (diagnostic || diagnosticError || diagnosticBusy) && (
              <section className="rounded-xl border border-white/10 bg-[#0D1018] p-4 sm:p-5 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-300 truncate">
                      Diagnóstico da conexão Neon (somente leitura)
                    </h2>
                    {diagnostic && (
                      <span className="text-[11px] font-mono text-slate-400 shrink-0">
                        {diagnostic.env.vercelEnv ?? 'local'} · {diagnostic.diagnosisCode}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowDiagnostic(false)}
                    aria-label="Fechar diagnóstico"
                    className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {diagnosticBusy && !diagnostic && (
                  <p className="text-xs text-slate-400">Executando diagnóstico no servidor...</p>
                )}

                {diagnosticError && (
                  <p className="text-xs text-rose-400" role="alert">
                    {diagnosticError}
                  </p>
                )}

                {diagnostic && (
                  <div className="space-y-3 text-xs">
                    <div
                      className={`rounded-lg border p-3 ${
                        diagnostic.diagnosisCode === 'ok'
                          ? 'bg-emerald-950/30 border-emerald-500/30 text-emerald-200'
                          : 'bg-amber-950/30 border-amber-500/30 text-amber-200'
                      }`}
                    >
                      <div className="font-semibold">
                        Diagnóstico ({diagnostic.diagnosisCode})
                      </div>
                      <p className="mt-1 leading-relaxed">{diagnostic.diagnosisSummary}</p>
                    </div>

                    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 bg-[#090B10] border border-white/10 rounded-lg p-3 font-mono">
                      <div className="flex justify-between gap-2">
                        <dt className="text-slate-400">DATABASE_URL:</dt>
                        <dd className="text-slate-200">
                          {diagnostic.env.configured
                            ? diagnostic.env.validUrl
                              ? 'Configurada (válida)'
                              : 'Configurada (inválida/incompleta)'
                            : 'Ausente'}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-slate-400">Pooling:</dt>
                        <dd className="text-slate-200">
                          {diagnostic.env.hasPooling ? 'Sim' : 'Não'}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2 sm:col-span-2">
                        <dt className="text-slate-400 shrink-0">Host (URL):</dt>
                        <dd className="text-slate-200 truncate">
                          {diagnostic.env.hostname ?? 'Não extraído'}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-slate-400">Banco (URL):</dt>
                        <dd className="text-slate-200">
                          {diagnostic.env.database ?? 'Não informado na URL'}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-slate-400">Registros:</dt>
                        <dd
                          className={
                            diagnostic.tableReadExecuted && !diagnostic.tableReadError
                              ? 'text-emerald-400'
                              : 'text-rose-400'
                          }
                        >
                          {diagnostic.tableReadExecuted && !diagnostic.tableReadError
                            ? `${diagnostic.episodeCount ?? 0} registro(s)`
                            : diagnostic.connectionEstablished
                              ? 'Falhou'
                              : 'Sem conexão'}
                        </dd>
                      </div>
                    </dl>

                    {diagnostic.missingColumns && diagnostic.missingColumns.length > 0 && (
                      <div className="bg-amber-950/40 border border-amber-500/40 rounded-lg p-3 space-y-2">
                        <div className="text-xs font-semibold text-amber-200">
                          Colunas ausentes: {diagnostic.missingColumns.join(', ')}
                        </div>
                        <div className="flex items-center gap-2">
                          <textarea
                            readOnly
                            rows={2}
                            value={diagnostic.correctionSql ?? ''}
                            className="flex-1 w-full p-2 rounded bg-[#090B10] border border-white/10 font-mono text-[11px] text-amber-200 select-all"
                          />
                          <button
                            type="button"
                            onClick={() => void copyLink('sql-fix', diagnostic.correctionSql ?? '')}
                            className="h-8 px-3 rounded bg-amber-600 hover:bg-amber-500 text-xs font-medium text-white inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                          >
                            {copiedId === 'sql-fix' ? 'Copiado' : 'Copiar SQL'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}

            {/* Saved episode public URL banner */}
            {savedBanner && (
              <div className="p-3.5 sm:p-4 rounded-xl bg-emerald-950/40 border border-emerald-500/30 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs sm:text-sm font-medium text-emerald-300">
                    {savedBanner.action === 'created'
                      ? `Episódio "${savedBanner.label}" cadastrado.`
                      : `Episódio "${savedBanner.label}" atualizado.`}
                  </div>
                  <button
                    type="button"
                    onClick={() => setSavedBanner(null)}
                    aria-label="Fechar aviso"
                    className="p-1 rounded text-emerald-300/70 hover:text-emerald-200 cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={savedBanner.publicUrl}
                    aria-label="Link público gerado"
                    className="flex-1 min-w-0 h-9 px-2.5 rounded-lg bg-[#090B10] border border-white/10 text-xs font-mono text-slate-200"
                  />
                  <button
                    type="button"
                    onClick={() => void copyLink('banner', savedBanner.publicUrl)}
                    className="h-9 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-medium text-white inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {copiedId === 'banner' ? (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        Copiado
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        Copiar link
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}

            {actionError && (
              <div className="rounded-xl border border-rose-500/30 bg-rose-950/30 px-4 py-3 text-xs sm:text-sm text-rose-300" role="alert">
                {actionError}
              </div>
            )}

            {/* VIEW 1: Create / Edit Episode Form (Single Player: Player 1 only) */}
            {formOpen ? (
              <section className="bg-[#11151E] border border-white/10 rounded-xl p-4 sm:p-6 space-y-5">
                <div className="flex items-center justify-between gap-3 pb-3 border-b border-white/10">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <button
                      type="button"
                      onClick={handleCloseForm}
                      className="h-9 px-2.5 rounded-lg border border-white/10 text-xs font-medium text-slate-200 hover:bg-white/5 inline-flex items-center gap-1.5 cursor-pointer shrink-0"
                    >
                      <ArrowLeft className="w-3.5 h-3.5" />
                      Voltar
                    </button>
                    <h1 className="text-base sm:text-lg font-semibold text-white truncate">
                      {editingId ? 'Editar episódio' : 'Novo episódio'}
                    </h1>
                  </div>
                </div>

                <form onSubmit={handleSaveEpisode} className="space-y-4">
                  {/* Anime name + Episode number */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div className="sm:col-span-2">
                      <label
                        htmlFor="ep-anime-name"
                        className="block text-xs font-medium text-slate-300 mb-1.5"
                      >
                        Nome do anime
                      </label>
                      <input
                        id="ep-anime-name"
                        type="text"
                        list="anime-names-datalist"
                        maxLength={160}
                        value={form.anime_name}
                        onChange={(e) => setForm({ ...form, anime_name: e.target.value })}
                        placeholder="Ex.: Frieren e a Jornada para o Além"
                        className="w-full h-11 px-3 rounded-lg bg-[#090B10] border border-white/15 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500"
                      />
                      <datalist id="anime-names-datalist">
                        {existingAnimeNames.map((name) => (
                          <option key={name} value={name} />
                        ))}
                      </datalist>
                    </div>

                    <div>
                      <label
                        htmlFor="ep-number"
                        className="block text-xs font-medium text-slate-300 mb-1.5"
                      >
                        Número do episódio
                      </label>
                      <input
                        id="ep-number"
                        type="text"
                        maxLength={32}
                        value={form.episode_number}
                        onChange={(e) => setForm({ ...form, episode_number: e.target.value })}
                        placeholder="Ex.: 01"
                        className="w-full h-11 px-3 rounded-lg bg-[#090B10] border border-white/15 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500"
                      />
                    </div>
                  </div>

                  {/* Episode title (if applicable) */}
                  <div>
                    <label
                      htmlFor="ep-title"
                      className="block text-xs font-medium text-slate-300 mb-1.5"
                    >
                      Título do episódio{' '}
                      <span className="text-slate-500 font-normal">(se aplicável)</span>
                    </label>
                    <input
                      id="ep-title"
                      type="text"
                      maxLength={200}
                      value={form.title}
                      onChange={(e) => setForm({ ...form, title: e.target.value })}
                      placeholder="Ex.: O Fim da Jornada"
                      className="w-full h-11 px-3 rounded-lg bg-[#090B10] border border-white/15 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500"
                    />
                  </div>

                  {/* Opening timestamps (optional) */}
                  <div className="pt-2 border-t border-white/10 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-medium text-slate-200">
                        Opening{' '}
                        <span className="text-slate-500 font-normal">(opcional)</span>
                      </span>
                      <span className="text-[11px] text-slate-400">
                        MM:SS ou HH:MM:SS
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label
                          htmlFor="ep-opening-start"
                          className="block text-xs font-medium text-slate-300 mb-1.5"
                        >
                          Início da opening
                        </label>
                        <input
                          id="ep-opening-start"
                          type="text"
                          inputMode="numeric"
                          maxLength={12}
                          value={form.opening_start}
                          onChange={(e) => setForm({ ...form, opening_start: e.target.value })}
                          placeholder="Ex.: 01:30"
                          className="w-full h-11 px-3 rounded-lg bg-[#090B10] border border-white/15 text-sm font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor="ep-opening-end"
                          className="block text-xs font-medium text-slate-300 mb-1.5"
                        >
                          Fim da opening
                        </label>
                        <input
                          id="ep-opening-end"
                          type="text"
                          inputMode="numeric"
                          maxLength={12}
                          value={form.opening_end}
                          onChange={(e) => setForm({ ...form, opening_end: e.target.value })}
                          placeholder="Ex.: 03:00"
                          className="w-full h-11 px-3 rounded-lg bg-[#090B10] border border-white/15 text-sm font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500"
                        />
                      </div>
                    </div>

                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      Deixe ambos os campos vazios se o episódio não tiver abertura configurada.
                    </p>
                  </div>

                  {/* Single Video Source: Player 1 only */}
                  <div className="pt-2 border-t border-white/10 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label
                        htmlFor="ep-video_url"
                        className="text-xs font-medium text-slate-200"
                      >
                        Fonte de vídeo (Player 1)
                      </label>

                      <div className="flex items-center gap-2">
                        {primarySourceInfo?.detectedKind && (
                          <span className="text-[11px] font-mono text-emerald-300">
                            {primarySourceInfo.detectedKind}
                          </span>
                        )}
                        {primarySourceInfo?.normalized ? (
                          <span className="text-[11px] font-mono text-slate-400">
                            {primarySourceInfo.normalized.formatLabel}
                          </span>
                        ) : primarySourceInfo?.check && !primarySourceInfo.check.valid ? (
                          <span className="text-[11px] text-rose-400">URL inválida</span>
                        ) : null}

                        {primarySourceInfo?.trimmed && (
                          <button
                            type="button"
                            disabled={
                              slotTesting || Boolean(!primarySourceInfo.check.valid)
                            }
                            onClick={() => void handleTestFormPrimarySource()}
                            className="h-7 px-2.5 rounded-md border border-white/15 bg-[#090B10] hover:bg-white/5 disabled:opacity-40 text-[11px] font-medium text-slate-200 inline-flex items-center gap-1 cursor-pointer whitespace-nowrap"
                          >
                            <Activity className="w-3 h-3" />
                            {slotTesting ? 'Testando...' : 'Testar fonte'}
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <input
                        id="ep-video_url"
                        type="url"
                        required
                        value={form.video_url}
                        onChange={(e) => setForm({ ...form, video_url: e.target.value })}
                        placeholder="https://.../playerricas.php?... ou https://.../index.m3u8"
                        className="flex-1 min-w-0 h-11 px-3 rounded-lg bg-[#090B10] border border-white/15 text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500"
                      />
                      <select
                        id="ep-source_kind"
                        aria-label="Tipo de fonte do Player 1"
                        value={form.source_kind}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            source_kind: e.target.value as ExplicitSourceKind | '',
                          })
                        }
                        className="h-11 px-2.5 rounded-lg bg-[#090B10] border border-white/15 text-xs font-mono text-slate-200 focus:outline-none focus:border-rose-500 shrink-0"
                      >
                        <option value="">auto</option>
                        <option value="iframe">iframe</option>
                        <option value="hls">hls</option>
                        <option value="mp4">mp4</option>
                      </select>
                    </div>

                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      Aceita URL direta (.m3u8, .mp4, .webm) ou página do provedor (.php, embed).
                    </p>

                    <div className="rounded-lg bg-[#090B10] border border-white/10 px-3 py-2 text-[11px] text-slate-300 space-y-1 leading-relaxed">
                      <div>
                        <span className="text-amber-300 font-medium">Exige /api/embed:</span>{' '}
                        <span className="font-mono text-slate-200">
                          {EMBED_PROXIED_HOSTS.join(', ')}
                        </span>{' '}
                        (CSP frame-ancestors bloqueia iframe direto)
                      </div>
                      <div>
                        <span className="text-emerald-300 font-medium">Iframe direto:</span>{' '}
                        <span className="font-mono text-slate-200">
                          {EMBED_DIRECT_HOSTS.join(', ')}
                        </span>
                      </div>
                      {primarySourceInfo?.check.valid &&
                        primarySourceInfo.detectedKind === 'iframe' && (
                          <div className="pt-0.5 text-slate-200">
                            Modo detectado para esta URL:{' '}
                            <span
                              className={`font-mono font-semibold ${
                                primarySourceInfo.embedHostMode === 'proxied'
                                  ? 'text-amber-300'
                                  : 'text-emerald-300'
                              }`}
                            >
                              {primarySourceInfo.embedHostMode === 'proxied'
                                ? 'via /api/embed'
                                : 'iframe direto'}
                            </span>
                          </div>
                        )}
                    </div>

                    {slotTestError && (
                      <p className="text-xs text-rose-400" role="alert">
                        {slotTestError}
                      </p>
                    )}

                    {slotReport && (
                      <div className="rounded-lg bg-[#090B10] border border-white/10 p-3 text-[11px] space-y-1 font-mono">
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={`font-semibold ${
                              slotReport.verdict === 'direto_ok'
                                ? 'text-emerald-400'
                                : slotReport.verdict === 'proxy_necessario'
                                  ? 'text-amber-300'
                                  : 'text-rose-400'
                            }`}
                          >
                            Veredito: {slotReport.verdictLabel}
                          </span>
                          <span className="text-slate-400">
                            kind: {slotReport.detectedKind}
                          </span>
                        </div>
                        <p className="font-sans text-slate-300 leading-snug">
                          {slotReport.verdictReason}
                        </p>
                        <div className="text-slate-300">
                          Sem cabeçalhos:{' '}
                          {slotReport.noHeaders.status !== null
                            ? `HTTP ${slotReport.noHeaders.status}`
                            : slotReport.noHeaders.error ?? 'erro'}{' '}
                          · ACAO:{' '}
                          {slotReport.noHeaders.accessControlAllowOrigin ?? 'ausente'}
                        </div>
                        <div className="text-slate-300">
                          UA + Referer ({slotReport.withHeaders.sentReferer ?? 'vazio'}):{' '}
                          {slotReport.withHeaders.status !== null
                            ? `HTTP ${slotReport.withHeaders.status}`
                            : slotReport.withHeaders.error ?? 'erro'}{' '}
                          · ACAO:{' '}
                          {slotReport.withHeaders.accessControlAllowOrigin ?? 'ausente'}
                        </div>
                        {slotReport.embedDiagnostic && (
                          <div className="text-slate-200 pt-1 border-t border-white/10 space-y-0.5">
                            <div>
                              Embed:{' '}
                              <span
                                className={
                                  slotReport.embedDiagnostic.hostCategory === 'proxied'
                                    ? 'text-amber-300'
                                    : 'text-emerald-300'
                                }
                              >
                                {slotReport.embedDiagnostic.hostLabel}
                              </span>
                            </div>
                            <div>
                              Fetch direto:{' '}
                              {slotReport.embedDiagnostic.directStatus !== null
                                ? `HTTP ${slotReport.embedDiagnostic.directStatus}`
                                : 'erro'}{' '}
                              · frame-ancestors:{' '}
                              {slotReport.embedDiagnostic.hasFrameAncestors
                                ? `presente (${slotReport.embedDiagnostic.frameAncestorsValue})`
                                : 'ausente'}
                            </div>
                            {slotReport.embedDiagnostic.hostCategory === 'proxied' && (
                              <>
                                <div>
                                  Via /api/embed:{' '}
                                  {slotReport.embedDiagnostic.embedProxyStatus !== null
                                    ? `HTTP ${slotReport.embedDiagnostic.embedProxyStatus}`
                                    : slotReport.embedDiagnostic.embedProxyError ?? 'erro'}
                                  {slotReport.embedDiagnostic.embedProxyError
                                    ? ` (${slotReport.embedDiagnostic.embedProxyError})`
                                    : ''}
                                </div>
                                {slotReport.embedDiagnostic.successfulStrategy && (
                                  <div>
                                    Estratégia:{' '}
                                    <span className="text-emerald-300">
                                      {slotReport.embedDiagnostic.successfulStrategy ===
                                      'chrome_ua_no_referer'
                                        ? 'UA Chrome sem Referer (fallback 403)'
                                        : 'UA Chrome + Referer (origem)'}
                                    </span>
                                  </div>
                                )}
                                {slotReport.embedDiagnostic.redirectChain.length > 0 && (
                                  <div className="pt-0.5 space-y-0.5">
                                    <div className="text-slate-400">Cadeia de saltos:</div>
                                    {slotReport.embedDiagnostic.redirectChain.map((hop, idx) => (
                                      <div key={`${hop.url}-${idx}`} className="pl-2 text-slate-300">
                                        {idx + 1}. {hop.host} ·{' '}
                                        {hop.status !== null ? `HTTP ${hop.status}` : 'bloqueado/erro'}
                                        {hop.authMode === 'chrome_ua_no_referer'
                                          ? ' [sem Referer]'
                                          : ' [com Referer]'}
                                        {hop.error ? ` · ${hop.error}` : ''}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        )}
                        {(slotReport.withHeaders.firstLine || slotReport.noHeaders.firstLine) && (
                          <div className="text-emerald-300/90 truncate">
                            1ª linha:{' '}
                            {slotReport.withHeaders.firstLine ?? slotReport.noHeaders.firstLine}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Episode poster image */}
                  <div>
                    <label
                      htmlFor="ep-poster"
                      className="block text-xs font-medium text-slate-300 mb-1.5"
                    >
                      Imagem do episódio (URL)
                    </label>
                    <input
                      id="ep-poster"
                      type="url"
                      required
                      value={form.poster_url}
                      onChange={(e) => {
                        setPosterPreviewError(false);
                        setForm({ ...form, poster_url: e.target.value });
                      }}
                      placeholder="https://cdn.exemplo.com/capas/ep01.jpg"
                      className="w-full h-11 px-3 rounded-lg bg-[#090B10] border border-white/15 text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500"
                    />
                    {posterValidation && !posterValidation.valid && (
                      <p className="mt-1 text-xs text-rose-400">{posterValidation.error}</p>
                    )}
                    {posterValidation?.valid && posterValidation.normalizedUrl && !posterPreviewError && (
                      <div className="mt-2.5 aspect-video max-w-sm w-full rounded-lg overflow-hidden border border-white/10 bg-[#090B10]">
                        <img
                          {...getOptimizedImageProps(posterValidation.normalizedUrl, 'capa')}
                          alt="Prévia da imagem do episódio"
                          referrerPolicy="no-referrer"
                          onError={() => setPosterPreviewError(true)}
                          className="w-full h-full object-cover"
                        />
                      </div>
                    )}
                  </div>

                  {formError && (
                    <p className="text-sm text-rose-400" role="alert">
                      {formError}
                    </p>
                  )}

                  <div className="pt-2 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2.5">
                    <button
                      type="button"
                      onClick={handleCloseForm}
                      className="h-11 px-4 rounded-lg border border-white/10 text-sm font-medium text-slate-300 hover:bg-white/5 cursor-pointer"
                    >
                      Cancelar
                    </button>
                    <button
                      type="submit"
                      disabled={saveBusy || !initialState.databaseConfigured}
                      className="h-11 px-5 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-sm font-medium text-white inline-flex items-center justify-center gap-2 transition-colors cursor-pointer"
                    >
                      <Plus className="w-4 h-4" />
                      {saveBusy
                        ? 'Salvando...'
                        : editingId
                          ? 'Salvar alterações'
                          : 'Cadastrar episódio'}
                    </button>
                  </div>
                </form>
              </section>
            ) : selectedGroup ? (
              /* VIEW 2: Episodes for Selected Anime */
              <section className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedAnimeKey(null);
                      setOpenMenuId(null);
                      setConfirmDeleteId(null);
                    }}
                    className="h-9 px-3 rounded-lg border border-white/10 bg-[#11151E] hover:bg-white/5 text-xs font-medium text-slate-200 inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    Voltar para animes
                  </button>

                  <button
                    type="button"
                    disabled={!initialState.databaseConfigured}
                    onClick={() =>
                      handleOpenCreateForm(selectedGroup.isUnassigned ? '' : selectedGroup.name)
                    }
                    className="h-9 px-3.5 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-xs font-medium text-white inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Novo episódio
                  </button>
                </div>

                {/* Anime group header */}
                <div className="bg-[#11151E] border border-white/10 rounded-xl p-4 sm:p-5 flex items-center gap-3.5">
                  <AnimeThumbnail
                    posterUrl={selectedGroup.representativePosterUrl}
                    alt={selectedGroup.name}
                    className="w-16 h-12 sm:w-20 sm:h-14"
                  />
                  <div className="min-w-0 flex-1">
                    <h1 className="text-base sm:text-lg font-semibold text-white truncate">
                      {selectedGroup.name}
                    </h1>
                    <p className="text-xs text-slate-400 mt-0.5 tabular-nums">
                      {selectedGroup.episodeCount}{' '}
                      {selectedGroup.episodeCount === 1 ? 'episódio' : 'episódios'}
                      {selectedGroup.isUnassigned
                        ? ' · Edite um registro para associar o nome do anime'
                        : ''}
                    </p>
                  </div>
                </div>

                {/* Episodes list */}
                <div
                  ref={menuContainerRef}
                  className="bg-[#11151E] border border-white/10 rounded-xl overflow-visible"
                >
                  <ul className="divide-y divide-white/10">
                    {selectedGroup.episodes.map((ep) => {
                      const sourceCount = countEpisodeSources(ep);
                      const isDeleting = confirmDeleteId === ep.id;
                      const isBusyDeleting = deleteBusyId === ep.id;
                      const isMenuOpen = openMenuId === ep.id;
                      const hasTitle = Boolean(ep.title && ep.title.trim());
                      const epLabel = formatEpisodeDisplayTitle(ep);
                      const isTesting = episodeTestingId === ep.id;
                      const testReports = episodeTests[ep.id];
                      const testError = episodeTestErrors[ep.id];

                      return (
                        <li
                          key={ep.id}
                          className="px-4 sm:px-5 py-3.5 sm:py-4 hover:bg-white/[0.02] transition-colors space-y-3"
                        >
                          <div className="flex items-start justify-between gap-3">
                            {/* Episode metadata */}
                            <div className="min-w-0 flex-1 space-y-1">
                              <div className="flex flex-wrap items-center gap-2 min-w-0">
                                {ep.episode_number && (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded bg-white/5 border border-white/10 text-xs font-mono text-slate-200 shrink-0 tabular-nums">
                                    Ep. {ep.episode_number}
                                  </span>
                                )}
                                {hasTitle ? (
                                  <h2 className="text-sm font-medium text-white truncate min-w-0">
                                    {ep.title}
                                  </h2>
                                ) : !ep.episode_number ? (
                                  <h2 className="text-sm font-medium text-slate-300 truncate min-w-0">
                                    {epLabel}
                                  </h2>
                                ) : null}
                              </div>

                              <p className="text-xs text-slate-400 tabular-nums">
                                {sourceCount} {sourceCount === 1 ? 'fonte' : 'fontes'}
                                <span aria-hidden="true"> · </span>
                                {formatDatePtBr(ep.created_at)}
                              </p>
                            </div>

                            {/* Compact actions: Copiar link, Abrir + 3-dots menu */}
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                onClick={() => void copyLink(ep.id, ep.public_url)}
                                aria-label={`Copiar link de ${epLabel}`}
                                className="h-9 px-2.5 rounded-lg border border-white/10 text-xs font-medium text-slate-200 hover:bg-white/5 inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                              >
                                {copiedId === ep.id ? (
                                  <>
                                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                                    <span className="hidden sm:inline">Copiado</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy className="w-3.5 h-3.5" />
                                    <span className="hidden sm:inline">Copiar link</span>
                                  </>
                                )}
                              </button>

                              <a
                                href={`/e/${encodeURIComponent(ep.id)}`}
                                target="_blank"
                                rel="noreferrer"
                                aria-label={`Abrir ${epLabel}`}
                                className="h-9 px-2.5 rounded-lg border border-white/10 text-xs font-medium text-slate-200 hover:bg-white/5 inline-flex items-center gap-1.5 whitespace-nowrap"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                                <span className="hidden sm:inline">Abrir</span>
                              </a>

                              {/* Three-dots secondary actions menu */}
                              <div className="relative" data-episode-menu-root="true">
                                <button
                                  type="button"
                                  onClick={() =>
                                    setOpenMenuId((curr) => (curr === ep.id ? null : ep.id))
                                  }
                                  aria-label={`Mais ações para ${epLabel}`}
                                  aria-haspopup="menu"
                                  aria-expanded={isMenuOpen}
                                  className="h-9 w-9 rounded-lg border border-white/10 text-slate-300 hover:text-white hover:bg-white/5 inline-flex items-center justify-center cursor-pointer"
                                >
                                  <MoreVertical className="w-4 h-4" />
                                </button>

                                {isMenuOpen && (
                                  <div
                                    role="menu"
                                    aria-label={`Ações de ${epLabel}`}
                                    className="absolute right-0 top-full mt-1.5 z-30 w-44 rounded-xl bg-[#0D1018] border border-white/15 shadow-xl py-1"
                                  >
                                    <button
                                      type="button"
                                      role="menuitem"
                                      onClick={() => handleEditStart(ep)}
                                      className="w-full px-3.5 py-2.5 text-left text-xs font-medium text-slate-200 hover:bg-white/5 inline-flex items-center gap-2.5 cursor-pointer"
                                    >
                                      <Pencil className="w-3.5 h-3.5 text-slate-400" />
                                      Editar
                                    </button>

                                    <button
                                      type="button"
                                      role="menuitem"
                                      disabled={isTesting}
                                      onClick={() => void handleTestEpisodeSources(ep)}
                                      className="w-full px-3.5 py-2.5 text-left text-xs font-medium text-slate-200 hover:bg-white/5 disabled:opacity-50 inline-flex items-center gap-2.5 cursor-pointer"
                                    >
                                      <Activity className="w-3.5 h-3.5 text-slate-400" />
                                      {isTesting ? 'Testando fonte...' : 'Testar fonte'}
                                    </button>

                                    <div className="my-1 border-t border-white/10" />

                                    <button
                                      type="button"
                                      role="menuitem"
                                      onClick={() => {
                                        setOpenMenuId(null);
                                        setConfirmDeleteId(ep.id);
                                      }}
                                      className="w-full px-3.5 py-2.5 text-left text-xs font-medium text-rose-300 hover:bg-rose-500/10 inline-flex items-center gap-2.5 cursor-pointer"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                      Excluir
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* Delete confirmation bar */}
                          {isDeleting && (
                            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-500/30 bg-rose-950/25 px-3 py-2.5">
                              <span className="text-xs text-rose-200">
                                Confirmar exclusão deste episódio?
                              </span>
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteId(null)}
                                  className="h-8 px-3 rounded-lg border border-white/10 text-xs text-slate-300 hover:bg-white/5 cursor-pointer"
                                >
                                  Cancelar
                                </button>
                                <button
                                  type="button"
                                  disabled={isBusyDeleting}
                                  onClick={() => void handleConfirmDelete(ep.id)}
                                  className="h-8 px-3 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-xs font-medium text-white cursor-pointer"
                                >
                                  {isBusyDeleting ? 'Excluindo...' : 'Confirmar'}
                                </button>
                              </div>
                            </div>
                          )}

                          {/* Testing feedback / diagnostic output */}
                          {isTesting && (
                            <p className="text-xs text-slate-400">
                              Verificando fonte no servidor...
                            </p>
                          )}

                          {testError && (
                            <div className="flex items-center justify-between gap-2 rounded-lg border border-rose-500/30 bg-rose-950/25 px-3 py-2 text-xs text-rose-300">
                              <span role="alert">{testError}</span>
                              <button
                                type="button"
                                onClick={() =>
                                  setEpisodeTestErrors((prev) => {
                                    const next = { ...prev };
                                    delete next[ep.id];
                                    return next;
                                  })
                                }
                                aria-label="Fechar erro do teste"
                                className="p-1 text-rose-300/70 hover:text-rose-200 cursor-pointer"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}

                          {testReports && testReports.length > 0 && (
                            <div className="space-y-1.5">
                              <div className="flex items-center justify-between">
                                <span className="text-[11px] font-medium text-slate-400">
                                  Resultado do teste de fonte
                                </span>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setEpisodeTests((prev) => {
                                      const next = { ...prev };
                                      delete next[ep.id];
                                      return next;
                                    })
                                  }
                                  className="text-[11px] text-slate-400 hover:text-white cursor-pointer"
                                >
                                  Fechar
                                </button>
                              </div>
                              <SourceDiagnosticTable reports={testReports} />
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </section>
            ) : (
              /* VIEW 3: Main Anime Library Screen */
              <section className="space-y-4">
                {/* Library title + totals + primary action */}
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-white">
                      Biblioteca de episódios
                    </h1>
                    <p className="text-xs sm:text-sm text-slate-400 mt-0.5 tabular-nums">
                      {identifiedAnimeCount}{' '}
                      {identifiedAnimeCount === 1 ? 'anime' : 'animes'}
                      <span aria-hidden="true"> · </span>
                      {initialState.episodes.length}{' '}
                      {initialState.episodes.length === 1 ? 'episódio' : 'episódios'}
                    </p>
                  </div>

                  <button
                    type="button"
                    disabled={!initialState.databaseConfigured}
                    onClick={() => handleOpenCreateForm()}
                    className="h-10 sm:h-10 px-4 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-sm font-medium text-white inline-flex items-center justify-center gap-2 transition-colors cursor-pointer shrink-0"
                  >
                    <Plus className="w-4 h-4" />
                    Novo episódio
                  </button>
                </div>

                {/* Search + Sort bar */}
                {initialState.episodes.length > 0 && (
                  <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
                    <div className="relative flex-1 min-w-0">
                      <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="search"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Pesquisar anime..."
                        aria-label="Pesquisar anime"
                        className="w-full h-10 pl-9 pr-9 rounded-lg bg-[#11151E] border border-white/10 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500"
                      />
                      {searchQuery && (
                        <button
                          type="button"
                          onClick={() => setSearchQuery('')}
                          aria-label="Limpar pesquisa"
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-slate-400 hover:text-white cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>

                    <div
                      role="group"
                      aria-label="Ordenar animes"
                      className="inline-flex p-1 rounded-lg bg-[#11151E] border border-white/10 shrink-0"
                    >
                      <button
                        type="button"
                        onClick={() => setSortBy('recent')}
                        aria-pressed={sortBy === 'recent'}
                        className={`flex-1 sm:flex-initial px-3 h-8 rounded-md text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                          sortBy === 'recent'
                            ? 'bg-white/10 text-white'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        Mais recentes
                      </button>
                      <button
                        type="button"
                        onClick={() => setSortBy('name')}
                        aria-pressed={sortBy === 'name'}
                        className={`flex-1 sm:flex-initial px-3 h-8 rounded-md text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                          sortBy === 'name'
                            ? 'bg-white/10 text-white'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        Nome (A–Z)
                      </button>
                    </div>
                  </div>
                )}

                {/* Empty state or anime cards */}
                {initialState.episodes.length === 0 ? (
                  <div className="bg-[#11151E] border border-white/10 rounded-xl px-6 py-14 text-center">
                    <Film className="w-9 h-9 text-slate-600 mx-auto mb-3" />
                    <p className="text-sm font-medium text-slate-200">
                      Nenhum episódio cadastrado ainda
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                      Cadastre o primeiro episódio para organizar sua biblioteca por anime.
                    </p>
                  </div>
                ) : filteredGroups.length === 0 ? (
                  <div className="bg-[#11151E] border border-white/10 rounded-xl px-6 py-12 text-center space-y-3">
                    <p className="text-sm text-slate-300">
                      Nenhum anime encontrado para “{searchQuery}”.
                    </p>
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="h-9 px-3.5 rounded-lg border border-white/10 text-xs font-medium text-slate-200 hover:bg-white/5 cursor-pointer"
                    >
                      Limpar pesquisa
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {filteredGroups.map((group) => (
                      <button
                        key={group.key}
                        type="button"
                        onClick={() => {
                          setSelectedAnimeKey(group.key);
                          setOpenMenuId(null);
                          setConfirmDeleteId(null);
                        }}
                        className="group w-full text-left bg-[#11151E] hover:bg-[#161B27] border border-white/10 hover:border-white/20 rounded-xl p-3.5 flex items-center gap-3.5 transition-colors cursor-pointer"
                      >
                        {group.isUnassigned && !group.representativePosterUrl ? (
                          <div className="w-20 h-14 rounded-lg bg-[#090B10] border border-white/10 flex items-center justify-center shrink-0">
                            <FolderOpen className="w-5 h-5 text-slate-500" />
                          </div>
                        ) : (
                          <AnimeThumbnail
                            posterUrl={group.representativePosterUrl}
                            alt={group.name}
                            className="w-20 h-14"
                          />
                        )}

                        <div className="min-w-0 flex-1">
                          <h2
                            className={`text-sm font-semibold truncate ${
                              group.key === UNASSIGNED_ANIME_KEY
                                ? 'text-slate-300'
                                : 'text-white'
                            }`}
                          >
                            {group.name}
                          </h2>
                          <p className="mt-0.5 text-xs text-slate-400 tabular-nums">
                            {group.episodeCount}{' '}
                            {group.episodeCount === 1 ? 'episódio' : 'episódios'}
                          </p>
                        </div>

                        <ChevronRight className="w-4 h-4 text-slate-500 group-hover:text-slate-200 transition-colors shrink-0" />
                      </button>
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function SourceDiagnosticTable({ reports }: { reports: SourceTestReport[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-white/10 bg-[#090B10]">
      <table className="w-full text-left border-collapse text-[11px]">
        <thead>
          <tr className="border-b border-white/10 text-slate-400">
            <th className="px-2.5 py-2 font-medium">Fonte</th>
            <th className="px-2.5 py-2 font-medium">Sem cabeçalhos</th>
            <th className="px-2.5 py-2 font-medium">UA + Referer</th>
            <th className="px-2.5 py-2 font-medium">Veredito</th>
            <th className="px-2.5 py-2 font-medium">1ª linha (200)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/10 font-mono">
          {reports.map((report) => {
            const firstLine =
              report.withHeaders.firstLine ?? report.noHeaders.firstLine ?? '—';
            return (
              <tr key={`${report.slot}-${report.url}`} className="align-top text-slate-200">
                <td className="px-2.5 py-2 whitespace-nowrap">
                  <div className="font-semibold text-white">{report.label}</div>
                  <div className="text-[10px] text-slate-400">{report.detectedKind}</div>
                </td>
                <td className="px-2.5 py-2 whitespace-nowrap">
                  <div>
                    {report.noHeaders.status !== null
                      ? `HTTP ${report.noHeaders.status}`
                      : report.noHeaders.error ?? 'erro'}
                  </div>
                  <div className="text-[10px] text-slate-400">
                    ACAO: {report.noHeaders.accessControlAllowOrigin ?? 'ausente'}
                  </div>
                </td>
                <td className="px-2.5 py-2 whitespace-nowrap">
                  <div>
                    {report.withHeaders.status !== null
                      ? `HTTP ${report.withHeaders.status}`
                      : report.withHeaders.error ?? 'erro'}
                  </div>
                  <div className="text-[10px] text-slate-400">
                    ACAO: {report.withHeaders.accessControlAllowOrigin ?? 'ausente'}
                  </div>
                  <div className="text-[10px] text-slate-500">
                    Ref: {report.withHeaders.sentReferer ?? 'vazio'}
                  </div>
                </td>
                <td className="px-2.5 py-2 whitespace-nowrap">
                  <span
                    className={`font-semibold ${
                      report.verdict === 'direto_ok'
                        ? 'text-emerald-400'
                        : report.verdict === 'proxy_necessario'
                          ? 'text-amber-300'
                          : 'text-rose-400'
                    }`}
                  >
                    {report.verdictLabel}
                  </span>
                  {report.embedDiagnostic && (
                    <div className="text-[10px] text-slate-300 mt-0.5 space-y-0.5">
                      <div>{report.embedDiagnostic.hostLabel}</div>
                      <div>
                        Direto:{' '}
                        {report.embedDiagnostic.directStatus !== null
                          ? `HTTP ${report.embedDiagnostic.directStatus}`
                          : 'erro'}{' '}
                        · frame-ancestors:{' '}
                        {report.embedDiagnostic.hasFrameAncestors ? 'presente' : 'ausente'}
                      </div>
                      {report.embedDiagnostic.hostCategory === 'proxied' && (
                        <>
                          <div>
                            /api/embed:{' '}
                            {report.embedDiagnostic.embedProxyStatus !== null
                              ? `HTTP ${report.embedDiagnostic.embedProxyStatus}`
                              : report.embedDiagnostic.embedProxyError ?? 'erro'}
                          </div>
                          {report.embedDiagnostic.successfulStrategy && (
                            <div className="text-emerald-300">
                              {report.embedDiagnostic.successfulStrategy === 'chrome_ua_no_referer'
                                ? 'Fallback sem Referer (403)'
                                : 'UA Chrome + Referer'}
                            </div>
                          )}
                          {report.embedDiagnostic.redirectChain.length > 0 && (
                            <div className="space-y-0.5 pt-0.5">
                              {report.embedDiagnostic.redirectChain.map((hop, idx) => (
                                <div key={`${hop.url}-${idx}`} className="text-slate-400">
                                  {idx + 1}. {hop.host}:{' '}
                                  {hop.status !== null ? `HTTP ${hop.status}` : hop.error ?? 'erro'}
                                  {hop.authMode === 'chrome_ua_no_referer' ? ' (sem Ref)' : ''}
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </td>
                <td className="px-2.5 py-2 max-w-[200px] truncate text-emerald-300/90" title={firstLine}>
                  {firstLine}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
