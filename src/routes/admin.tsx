import { createFileRoute, useCanGoBack, useRouter } from '@tanstack/react-router';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  CopyPlus,
  Database,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Film,
  FolderOpen,
  Globe,
  Hash,
  Image as ImageIcon,
  ListPlus,
  Loader2,
  LogOut,
  MoreVertical,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AdminBackPlan,
  getActiveAdminView,
  parseAdminSearch,
  resolveAdminBackPlan,
  resolvePostSaveNavigationPlan,
} from '@/lib/admin-navigation';
import {
  type AnimeSortMode,
  countEpisodeSources,
  formatEpisodeIdentification,
  groupEpisodesByAnime,
  normalizeAnimeKey,
  paginateItems,
  sanitizeAnimeName,
  sanitizeEpisodeNumber,
  searchAndSortAnimeGroups,
  UNASSIGNED_ANIME_KEY,
} from '@/lib/anime-library';
import {
  BATCH_ITEM_DELAY_MS,
  BATCH_MAX_ITEMS,
  type BatchImportJobState,
  type BatchImportMode,
  type BatchItemReport,
  clearBatchJobState,
  computeBatchTotals,
  hasPendingBatchResume,
  loadBatchJobState,
  parseBatchInputLines,
  runBatchSequence,
  saveBatchJobState,
} from '@/lib/batch-import';
import {
  extractVideoThumbnails,
  revokeThumbnailCandidates,
} from '@/lib/client-thumbnail-extractor';
import {
  copyEpisodeField,
  createEpisodeCopyKey,
  type EpisodeCopyField,
  type EpisodeCopyOutcome,
  getEpisodeCopyPosterUrl,
} from '@/lib/episode-copy';
import { getOptimizedImageProps } from '@/lib/image-optimization';
import { formatOpeningTimestamp, parseOpeningRange } from '@/lib/opening-skip';
import { PLAYBACK_SOURCE_CATEGORY_LABELS } from '@/lib/playback-diagnostics';
import type { PlaybackDiagnosticsSnapshot } from '@/lib/playback-diagnostics-store';
import {
  adminClearPlaybackDiagnosticsFn,
  adminCreateEpisodeFn,
  adminDeleteEpisodeFn,
  adminDiagnoseDatabaseFn,
  adminDuplicateEpisodeFn,
  adminGetPlaybackDiagnosticsFn,
  adminLoginFn,
  adminLogoutFn,
  adminProcessBatchItemFn,
  adminResolveR2SourceFn,
  adminResolveThumbnailSourceFn,
  adminTestEpisodeSourcesFn,
  adminTestSourceFn,
  adminUpdateEpisodeFn,
  getAdminDashboardFn,
} from '@/lib/server-fns';
import type { GeneratedThumbnailCandidate } from '@/lib/thumbnail-utils';
import type {
  DatabaseDiagnosticResult,
  EpisodeDto,
  SourceTestReport,
} from '@/lib/types';
import {
  classifyEmbedHost,
  detectSourceKind,
  EMBED_DIRECT_HOSTS,
  EMBED_NO_REFERRER_HOSTS,
  EMBED_PROXIED_HOSTS,
  type ExplicitSourceKind,
  getEpisodeMirrorInfo,
  getIframeReferrerPolicy,
  type GoogleVideoSourceInspection,
  hasUrlHashParams,
  inspectGoogleVideoSourceUrl,
  inspectR2SourceUrl,
  isExpirableHlsSourceUrl,
  isR2StorageUrl,
  isVercelBlobUrl,
  MAX_VIDEO_SOURCE_URL_LENGTH,
  normalizeVideoSource,
  type R2SourceInspection,
  validateHttpUrl,
} from '@/lib/video-sources';
import {
  applyResolvedR2Candidate,
  type ControlledR2ResolutionResult,
  extractPrefixFromPlayerricasName,
  isR2SignedUrl,
} from '@/lib/r2-resolver';

export const Route = createFileRoute('/admin')({
  validateSearch: parseAdminSearch,
  staleTime: 0,
  gcTime: 0,
  loader: async () => {
    return await getAdminDashboardFn();
  },
  headers: () => ({
    'Cache-Control': 'private, no-store',
    'CDN-Cache-Control': 'private, no-store',
    Vary: 'Cookie',
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
  source_referer: string;
  force_proxy: boolean;
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
  source_referer: '',
  force_proxy: true,
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

interface EpisodeSourceRow {
  slot: 1 | 2 | 3 | 4 | 5;
  url: string;
  kind: ExplicitSourceKind;
  isMirror: boolean;
  isExpirable: boolean;
  r2Inspection: R2SourceInspection;
  googleVideoInspection: GoogleVideoSourceInspection;
  sourceReferer: string | null;
}

function getEpisodeSourcesList(ep: EpisodeDto): EpisodeSourceRow[] {
  const rawSlots: Array<{
    slot: 1 | 2 | 3 | 4 | 5;
    url: string | null | undefined;
    explicitKind: ExplicitSourceKind | null | undefined;
    isMirrorFlag: boolean | null | undefined;
    sourceReferer: string | null | undefined;
  }> = [
    {
      slot: 1,
      url: ep.video_url,
      explicitKind: ep.source_kind,
      isMirrorFlag: ep.is_mirror,
      sourceReferer: ep.source_referer,
    },
    {
      slot: 2,
      url: ep.video_url_2,
      explicitKind: ep.source_kind_2,
      isMirrorFlag: ep.is_mirror_2,
      sourceReferer: ep.source_referer_2,
    },
    {
      slot: 3,
      url: ep.video_url_3,
      explicitKind: ep.source_kind_3,
      isMirrorFlag: ep.is_mirror_3,
      sourceReferer: ep.source_referer_3,
    },
    {
      slot: 4,
      url: ep.video_url_4,
      explicitKind: ep.source_kind_4,
      isMirrorFlag: ep.is_mirror_4,
      sourceReferer: ep.source_referer_4,
    },
    {
      slot: 5,
      url: ep.video_url_5,
      explicitKind: ep.source_kind_5,
      isMirrorFlag: ep.is_mirror_5,
      sourceReferer: ep.source_referer_5,
    },
  ];

  const list: EpisodeSourceRow[] = [];
  for (const entry of rawSlots) {
    const trimmed = entry.url?.trim();
    if (!trimmed) continue;
    const isMirror = Boolean(entry.isMirrorFlag || isVercelBlobUrl(trimmed));
    list.push({
      slot: entry.slot,
      url: trimmed,
      kind: isMirror ? 'mp4' : detectSourceKind(trimmed, entry.explicitKind),
      isMirror,
      isExpirable: !isMirror && isExpirableHlsSourceUrl(trimmed, entry.explicitKind),
      r2Inspection: isMirror ? inspectR2SourceUrl('') : inspectR2SourceUrl(trimmed),
      googleVideoInspection: isMirror
        ? inspectGoogleVideoSourceUrl('')
        : inspectGoogleVideoSourceUrl(trimmed),
      sourceReferer: entry.sourceReferer?.trim() || null,
    });
  }
  return list;
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
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const canGoBack = useCanGoBack();

  const activeView = getActiveAdminView(search);
  const batchOpen = activeView === 'batch';
  const formOpen = activeView === 'create' || activeView === 'edit';
  const editingId = activeView === 'edit' ? (search.ep ?? null) : null;

  const syncedFormRouteKeyRef = useRef<string | null>(null);
  const lastLibraryIndexRef = useRef<number | null>(null);
  const hasAutoOpenedBatchRef = useRef(false);

  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);

  // Navigation, grouping & library filtering state
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [pendingFocusGroupKey, setPendingFocusGroupKey] = useState<string | null>(null);
  const [groupPage, setGroupPage] = useState(1);
  const [episodePageMap, setEpisodePageMap] = useState<Record<string, number>>({});
  const [openMirrorPanelIds, setOpenMirrorPanelIds] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<AnimeSortMode>('recent');

  // Form modal/panel state (single primary URL)
  const [form, setForm] = useState<SinglePlayerFormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [posterPreviewError, setPosterPreviewError] = useState(false);

  // Manual episode thumbnail generation & selection state (never auto-selected or auto-saved)
  const [thumbBusy, setThumbBusy] = useState(false);
  const [thumbProgress, setThumbProgress] = useState<{ completed: number; total: number } | null>(
    null
  );
  const [thumbCandidates, setThumbCandidates] = useState<GeneratedThumbnailCandidate[]>([]);
  const [selectedThumbId, setSelectedThumbId] = useState<string | null>(null);
  const [thumbError, setThumbError] = useState<string | null>(null);
  const [thumbSourceInfo, setThumbSourceInfo] = useState<{
    label: string;
    blobPreferred: boolean;
  } | null>(null);
  const thumbAbortRef = useRef<AbortController | null>(null);
  const thumbCandidatesRef = useRef<GeneratedThumbnailCandidate[]>([]);
  thumbCandidatesRef.current = thumbCandidates;

  const [savedBanner, setSavedBanner] = useState<{
    label: string;
    publicUrl: string;
    action: 'created' | 'updated';
  } | null>(null);

  // Episode actions state
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [episodeCopyFeedback, setEpisodeCopyFeedback] = useState<
    Record<string, EpisodeCopyOutcome>
  >({});
  const episodeCopyTimersRef = useRef<Record<string, number>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null);
  const [duplicatingEpisodeId, setDuplicatingEpisodeId] = useState<string | null>(null);
  const [duplicatedNotice, setDuplicatedNotice] = useState<{
    newId: string;
    sourceTitle: string;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const duplicateLockRef = useRef(false);

  // Source diagnostics (form Player 1 + episode list)
  const [slotTesting, setSlotTesting] = useState(false);
  const [slotReport, setSlotReport] = useState<SourceTestReport | null>(null);
  const [slotTestError, setSlotTestError] = useState<string | null>(null);

  // Controlled R2 resolution state (never auto-replaces form.video_url)
  const [r2ResolveBusy, setR2ResolveBusy] = useState(false);
  const [r2ResolveResult, setR2ResolveResult] = useState<ControlledR2ResolutionResult | null>(null);
  const [r2ResolveError, setR2ResolveError] = useState<string | null>(null);
  const [r2AppliedNotice, setR2AppliedNotice] = useState<string | null>(null);

  const [episodeTests, setEpisodeTests] = useState<Record<string, SourceTestReport[]>>({});
  const [episodeTestingId, setEpisodeTestingId] = useState<string | null>(null);
  const [episodeTestErrors, setEpisodeTestErrors] = useState<Record<string, string>>({});

  // Vercel Blob mirror state per episode
  const [mirrorInputs, setMirrorInputs] = useState<Record<string, string>>({});
  const [mirrorForceMap, setMirrorForceMap] = useState<Record<string, boolean>>({});
  const [mirrorBusyId, setMirrorBusyId] = useState<string | null>(null);
  const [mirrorErrorMap, setMirrorErrorMap] = useState<Record<string, string>>({});
  const [mirrorSuccessMap, setMirrorSuccessMap] = useState<Record<string, string>>({});

  // Neon DB diagnostic state
  const [showDiagnostic, setShowDiagnostic] = useState(false);
  const [diagnostic, setDiagnostic] = useState<DatabaseDiagnosticResult | null>(null);
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);

  // Playback stability diagnostic state
  const [showPlaybackDiagnostics, setShowPlaybackDiagnostics] = useState(false);
  const [playbackDiagnostics, setPlaybackDiagnostics] = useState<PlaybackDiagnosticsSnapshot | null>(
    null
  );
  const [playbackDiagnosticsBusy, setPlaybackDiagnosticsBusy] = useState(false);
  const [playbackDiagnosticsError, setPlaybackDiagnosticsError] = useState<string | null>(null);

  // Batch import state ("Importar em lote")
  const [batchInput, setBatchInput] = useState('');
  const [batchJob, setBatchJob] = useState<BatchImportJobState | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const batchStopRef = useRef(false);

  const menuContainerRef = useRef<HTMLDivElement | null>(null);

  // Restore saved batch import job on load/reload so progress is never lost
  useEffect(() => {
    const saved = loadBatchJobState();
    if (!saved) return;
    setBatchJob(saved);
    if (saved.rawInput && !batchInput) {
      setBatchInput(saved.rawInput);
    }
    if (
      !hasAutoOpenedBatchRef.current &&
      initialState.authenticated &&
      activeView === 'library' &&
      hasPendingBatchResume(saved)
    ) {
      hasAutoOpenedBatchRef.current = true;
      lastLibraryIndexRef.current = router.history.location.state.__TSR_index ?? null;
      void navigate({
        to: '/admin',
        search: { view: 'batch' },
      });
    }
  }, [activeView, initialState.authenticated, navigate, router]);

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

  const GROUPS_PER_PAGE = 15;
  const EPISODES_PER_GROUP_PAGE = 25;

  const animeGroups = useMemo(
    () => groupEpisodesByAnime(initialState.episodes),
    [initialState.episodes]
  );

  const filteredGroups = useMemo(
    () => searchAndSortAnimeGroups(animeGroups, searchQuery, sortBy),
    [animeGroups, searchQuery, sortBy]
  );

  const pagedGroups = useMemo(
    () => paginateItems(filteredGroups, groupPage, GROUPS_PER_PAGE),
    [filteredGroups, groupPage]
  );

  const isGroupExpanded = useCallback(
    (groupKey: string) => {
      if (expandedGroups[groupKey] !== undefined) {
        return expandedGroups[groupKey];
      }
      if (searchQuery.trim().length > 0 && filteredGroups.length <= 3) {
        return true;
      }
      return filteredGroups.length === 1;
    },
    [expandedGroups, searchQuery, filteredGroups.length]
  );

  const allVisibleExpanded = useMemo(
    () =>
      pagedGroups.items.length > 0 &&
      pagedGroups.items.every((group) => isGroupExpanded(group.key)),
    [pagedGroups.items, isGroupExpanded]
  );

  const toggleGroup = (groupKey: string) => {
    const currentlyExpanded = isGroupExpanded(groupKey);
    setExpandedGroups((prev) => ({
      ...prev,
      [groupKey]: !currentlyExpanded,
    }));
    setOpenMenuId(null);
    setConfirmDeleteId(null);
  };

  const handleToggleAllGroups = () => {
    const nextValue = !allVisibleExpanded;
    setExpandedGroups((prev) => {
      const next = { ...prev };
      for (const group of filteredGroups) {
        next[group.key] = nextValue;
      }
      return next;
    });
    setOpenMenuId(null);
  };

  // Focus & expand target group automatically after creating/editing an episode
  useEffect(() => {
    if (!pendingFocusGroupKey) return;
    const idx = filteredGroups.findIndex((g) => g.key === pendingFocusGroupKey);
    if (idx >= 0) {
      const targetPage = Math.floor(idx / GROUPS_PER_PAGE) + 1;
      setGroupPage(targetPage);
      setExpandedGroups((prev) => ({ ...prev, [pendingFocusGroupKey]: true }));
      setPendingFocusGroupKey(null);
    } else if (searchQuery.trim()) {
      setSearchQuery('');
    } else {
      setPendingFocusGroupKey(null);
    }
  }, [pendingFocusGroupKey, filteredGroups, searchQuery]);

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

  const loadPlaybackDiagnostics = async () => {
    setShowPlaybackDiagnostics(true);
    setPlaybackDiagnosticsBusy(true);
    setPlaybackDiagnosticsError(null);
    try {
      const res = await adminGetPlaybackDiagnosticsFn();
      if (!res.ok) {
        setPlaybackDiagnosticsError(res.error);
        return;
      }
      setPlaybackDiagnostics(res.snapshot);
    } catch (err) {
      setPlaybackDiagnosticsError(
        err instanceof Error ? err.message : 'Falha ao carregar diagnóstico de reprodução.'
      );
    } finally {
      setPlaybackDiagnosticsBusy(false);
    }
  };

  const clearPlaybackDiagnostics = async () => {
    setPlaybackDiagnosticsBusy(true);
    setPlaybackDiagnosticsError(null);
    try {
      const res = await adminClearPlaybackDiagnosticsFn();
      if (!res.ok) {
        setPlaybackDiagnosticsError(res.error);
        return;
      }
      setPlaybackDiagnostics(res.snapshot);
    } catch (err) {
      setPlaybackDiagnosticsError(
        err instanceof Error ? err.message : 'Falha ao limpar diagnóstico de reprodução.'
      );
    } finally {
      setPlaybackDiagnosticsBusy(false);
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
    const check = validateHttpUrl(trimmed, MAX_VIDEO_SOURCE_URL_LENGTH);
    const normalized = normalizeVideoSource(trimmed, 1, form.source_kind || null);
    const detectedKind = detectSourceKind(trimmed, form.source_kind || null);
    const candidateUrl = check.normalizedUrl ?? trimmed;
    const embedHostMode = classifyEmbedHost(candidateUrl);
    const hasHashParams = hasUrlHashParams(candidateUrl);
    const isExpirableUrl = isExpirableHlsSourceUrl(candidateUrl, form.source_kind || null);
    const referrerPolicy = getIframeReferrerPolicy(candidateUrl);
    const r2Inspection = inspectR2SourceUrl(candidateUrl);
    const googleVideoInspection = inspectGoogleVideoSourceUrl(candidateUrl);
    const isR2 = isR2SignedUrl(trimmed);
    const isCleanR2 = r2Inspection.isR2 && !r2Inspection.hasAmzSignature;
    const isUnconfirmed = trimmed.includes('unconfirmed=1') || isR2 || isCleanR2 || isR2StorageUrl(trimmed);
    let detectedPrefix: string | null = null;
    if (!isUnconfirmed && trimmed.toLowerCase().includes('playerricas.php')) {
      try {
        const parsed = new URL(trimmed);
        detectedPrefix = extractPrefixFromPlayerricasName(parsed.searchParams.get('name'));
      } catch {}
    }
    return {
      trimmed,
      check,
      normalized,
      detectedKind,
      embedHostMode,
      hasHashParams,
      isExpirableUrl,
      referrerPolicy,
      detectedPrefix,
      isR2,
      r2Inspection,
      googleVideoInspection,
      isUnconfirmed,
    };
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

  useEffect(() => {
    return () => {
      Object.values(episodeCopyTimersRef.current).forEach((timerId) => {
        window.clearTimeout(timerId);
      });
      episodeCopyTimersRef.current = {};
    };
  }, []);

  const handleCopyEpisodeField = async (ep: EpisodeDto, field: EpisodeCopyField) => {
    const key = createEpisodeCopyKey(ep.id, field);
    const activeTimer = episodeCopyTimersRef.current[key];
    if (activeTimer !== undefined) {
      window.clearTimeout(activeTimer);
      delete episodeCopyTimersRef.current[key];
    }

    const outcome = await copyEpisodeField(ep, field);
    setEpisodeCopyFeedback((prev) => ({ ...prev, [key]: outcome }));

    const durationMs = outcome.ok ? 2200 : 3500;
    episodeCopyTimersRef.current[key] = window.setTimeout(() => {
      delete episodeCopyTimersRef.current[key];
      setEpisodeCopyFeedback((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }, durationMs);
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

  const executeBackPlan = useCallback(
    (plan: AdminBackPlan) => {
      if (plan.type === 'history_back') {
        router.history.back();
        return;
      }
      void navigate({
        to: plan.to,
        search: plan.search,
        replace: plan.replace,
      });
    },
    [navigate, router]
  );

  const handleGoBackFromSubView = useCallback(() => {
    executeBackPlan(
      resolveAdminBackPlan({
        canGoBack,
        currentView: activeView,
      })
    );
  }, [activeView, canGoBack, executeBackPlan]);

  const resetThumbnailState = useCallback(() => {
    if (thumbAbortRef.current) {
      thumbAbortRef.current.abort();
      thumbAbortRef.current = null;
    }
    if (thumbCandidatesRef.current.length > 0) {
      revokeThumbnailCandidates(thumbCandidatesRef.current);
    }
    setThumbBusy(false);
    setThumbProgress(null);
    setThumbCandidates([]);
    setSelectedThumbId(null);
    setThumbError(null);
    setThumbSourceInfo(null);
  }, []);

  useEffect(() => {
    return () => {
      if (thumbAbortRef.current) {
        thumbAbortRef.current.abort();
      }
      if (thumbCandidatesRef.current.length > 0) {
        revokeThumbnailCandidates(thumbCandidatesRef.current);
      }
    };
  }, []);

  const resetFormTestState = useCallback(() => {
    setFormError(null);
    setPosterPreviewError(false);
    setSlotTesting(false);
    setSlotReport(null);
    setSlotTestError(null);
    setR2ResolveBusy(false);
    setR2ResolveResult(null);
    setR2ResolveError(null);
    setR2AppliedNotice(null);
    resetThumbnailState();
  }, [resetThumbnailState]);

  const handleLogout = async () => {
    await adminLogoutFn();
    syncedFormRouteKeyRef.current = null;
    lastLibraryIndexRef.current = null;
    setForm(EMPTY_FORM);
    setDuplicatedNotice(null);
    resetFormTestState();
    setExpandedGroups({});
    setPendingFocusGroupKey(null);
    setGroupPage(1);
    setSearchQuery('');
    setSavedBanner(null);
    Object.values(episodeCopyTimersRef.current).forEach((timerId) => {
      window.clearTimeout(timerId);
    });
    episodeCopyTimersRef.current = {};
    setEpisodeCopyFeedback({});
    setShowDiagnostic(false);
    setDiagnostic(null);
    setDiagnosticError(null);
    if (activeView !== 'library') {
      await navigate({ to: '/admin', search: {}, replace: true });
    }
    await router.invalidate();
  };

  const handleOpenCreateForm = (prefillAnimeName?: string) => {
    const cleanPrefill = prefillAnimeName?.trim() ?? '';
    setDuplicatedNotice(null);
    syncedFormRouteKeyRef.current = `create:${cleanPrefill}`;
    setForm({
      ...EMPTY_FORM,
      anime_name: cleanPrefill,
    });
    resetFormTestState();
    setOpenMenuId(null);
    setConfirmDeleteId(null);
    lastLibraryIndexRef.current =
      activeView === 'library' ? (router.history.location.state.__TSR_index ?? null) : null;
    void navigate({
      to: '/admin',
      search: cleanPrefill ? { view: 'create', anime: cleanPrefill } : { view: 'create' },
    });
  };

  const handleEditStart = (ep: EpisodeDto) => {
    setDuplicatedNotice(null);
    syncedFormRouteKeyRef.current = `edit:${ep.id}`;
    setForm({
      anime_name: ep.anime_name ?? '',
      episode_number: ep.episode_number ?? '',
      title: ep.title ?? '',
      opening_start: formatOpeningTimestamp(ep.opening_start_seconds),
      opening_end: formatOpeningTimestamp(ep.opening_end_seconds),
      poster_url: ep.poster_url,
      video_url: ep.video_url,
      source_kind: ep.source_kind ?? '',
      source_referer: ep.source_referer ?? '',
      force_proxy: ep.force_proxy !== false,
    });
    resetFormTestState();
    setOpenMenuId(null);
    setConfirmDeleteId(null);
    lastLibraryIndexRef.current =
      activeView === 'library' ? (router.history.location.state.__TSR_index ?? null) : null;
    void navigate({
      to: '/admin',
      search: { view: 'edit', ep: ep.id },
    });
  };

  const handleCloseForm = () => {
    syncedFormRouteKeyRef.current = null;
    setDuplicatedNotice(null);
    setForm(EMPTY_FORM);
    resetFormTestState();
    handleGoBackFromSubView();
  };

  const handleClearPrimarySource = () => {
    setForm((prev) => ({
      ...prev,
      video_url: '',
      source_kind: '',
      source_referer: '',
    }));
    setFormError(null);
    setSlotReport(null);
    setSlotTestError(null);
    setR2ResolveResult(null);
    setR2ResolveError(null);
    setR2AppliedNotice(null);
  };

  const handleTestFormPrimarySource = async () => {
    const trimmed = form.video_url.trim();
    if (!trimmed) return;
    setSlotTesting(true);
    setSlotTestError(null);
    const editingEp = editingId
      ? initialState.episodes.find((item) => item.id === editingId) ?? null
      : null;
    const siblingOriginal = editingEp
      ? getEpisodeSourcesList(editingEp).find(
          (src) => src.slot !== 1 && !src.isMirror && src.kind !== 'iframe'
        )
      : undefined;
    try {
      const res = await adminTestSourceFn({
        data: {
          slot: 1,
          label: 'Player 1',
          url: trimmed,
          kind: form.source_kind,
          sourceReferer: form.source_referer.trim() || null,
          isMirror: isVercelBlobUrl(trimmed),
          originalUrl: siblingOriginal?.url ?? null,
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

  const handleAttemptControlledR2Resolution = async () => {
    const trimmed = form.video_url.trim();
    if (!trimmed) return;
    setR2ResolveBusy(true);
    setR2ResolveError(null);
    setR2ResolveResult(null);
    setR2AppliedNotice(null);
    try {
      const res = await adminResolveR2SourceFn({ data: { url: trimmed } });
      if (!res.ok) {
        setR2ResolveError(res.error);
        return;
      }
      setR2ResolveResult(res.resolution);
    } catch (err) {
      setR2ResolveError(
        err instanceof Error ? err.message : 'Falha ao tentar resolver o link R2.'
      );
    } finally {
      setR2ResolveBusy(false);
    }
  };

  const handleConfirmApplyR2Candidate = () => {
    const applied = applyResolvedR2Candidate(
      { video_url: form.video_url, source_kind: form.source_kind },
      r2ResolveResult,
      true
    );
    if (!applied.applied) return;
    setForm((prev) => ({
      ...prev,
      video_url: applied.video_url,
      source_kind: applied.source_kind,
    }));
    setR2AppliedNotice(
      `Fonte aplicada ao formulário (${r2ResolveResult?.matchedPrefix ?? 'playerricas'} · ${applied.source_kind || 'auto'}). Clique em Salvar para gravar no episódio.`
    );
    setR2ResolveResult(null);
    setSlotReport(null);
  };

  const handleDiscardR2Candidate = () => {
    setR2ResolveResult(null);
    setR2ResolveError(null);
    setR2AppliedNotice(null);
  };

  const handleTestEpisodeSources = async (ep: EpisodeDto) => {
    const episodeSources = getEpisodeSourcesList(ep);
    if (episodeSources.length === 0) return;

    const typedOriginalUrl = (mirrorInputs[ep.id] ?? '').trim();

    setOpenMenuId(null);
    setEpisodeTestingId(ep.id);
    setEpisodeTestErrors((prev) => {
      const next = { ...prev };
      delete next[ep.id];
      return next;
    });
    try {
      const res = await adminTestEpisodeSourcesFn({
        data: {
          sources: episodeSources.map((src) => ({
            slot: src.slot,
            label: `Player ${src.slot}${src.isMirror ? ' (espelho)' : ''}`,
            url: src.url,
            kind: src.kind,
            sourceReferer: src.sourceReferer,
            isMirror: src.isMirror,
            originalUrl: src.isMirror && typedOriginalUrl ? typedOriginalUrl : null,
          })),
        },
      });
      if (!res.ok) {
        setEpisodeTestErrors((prev) => ({ ...prev, [ep.id]: res.error }));
      } else {
        setEpisodeTests((prev) => ({ ...prev, [ep.id]: res.reports }));
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

  const selectedThumbnail = useMemo(
    () => thumbCandidates.find((item) => item.id === selectedThumbId) ?? null,
    [thumbCandidates, selectedThumbId]
  );

  const editingEpisode = useMemo(() => {
    if (!editingId) return null;
    return initialState.episodes.find((item) => item.id === editingId) ?? null;
  }, [editingId, initialState.episodes]);

  // Keep form state synchronized when navigating via browser history (Back/Forward) or direct URL
  useEffect(() => {
    if (!initialState.authenticated) {
      syncedFormRouteKeyRef.current = null;
      return;
    }

    if (activeView === 'create') {
      const key = `create:${search.anime ?? ''}`;
      if (syncedFormRouteKeyRef.current !== key) {
        syncedFormRouteKeyRef.current = key;
        setDuplicatedNotice(null);
        setForm({
          ...EMPTY_FORM,
          anime_name: search.anime ?? '',
        });
        resetFormTestState();
      }
      return;
    }

    if (activeView === 'edit' && editingId) {
      const key = `edit:${editingId}`;
      if (editingEpisode && syncedFormRouteKeyRef.current !== key) {
        syncedFormRouteKeyRef.current = key;
        setForm({
          anime_name: editingEpisode.anime_name ?? '',
          episode_number: editingEpisode.episode_number ?? '',
          title: editingEpisode.title ?? '',
          opening_start: formatOpeningTimestamp(editingEpisode.opening_start_seconds),
          opening_end: formatOpeningTimestamp(editingEpisode.opening_end_seconds),
          poster_url: editingEpisode.poster_url,
          video_url: editingEpisode.video_url,
          source_kind: editingEpisode.source_kind ?? '',
          source_referer: editingEpisode.source_referer ?? '',
          force_proxy: editingEpisode.force_proxy !== false,
        });
        resetFormTestState();
      }
      return;
    }

    syncedFormRouteKeyRef.current = null;
  }, [
    activeView,
    editingEpisode,
    editingId,
    initialState.authenticated,
    resetFormTestState,
    search.anime,
  ]);

  const editingEpisodeSources = useMemo(() => {
    return editingEpisode ? getEpisodeSourcesList(editingEpisode) : [];
  }, [editingEpisode]);

  const editingOtherSources = useMemo(
    () => editingEpisodeSources.filter((src) => src.slot !== 1),
    [editingEpisodeSources]
  );

  const editingHasFallbackSources = editingOtherSources.length > 0;

  const editingMirrorInfo = useMemo(
    () =>
      editingEpisode
        ? getEpisodeMirrorInfo(editingEpisode)
        : { hasMirror: false, slot: null, url: null, kind: null, isVercelBlob: false },
    [editingEpisode]
  );

  const hasAnyThumbnailSource = Boolean(
    form.video_url.trim() || editingEpisodeSources.length > 0
  );
  const hasBlobThumbnailSource = Boolean(
    isVercelBlobUrl(form.video_url.trim()) ||
      editingEpisodeSources.some((src) => isVercelBlobUrl(src.url) || src.isMirror)
  );

  const handleGenerateThumbnails = async () => {
    if (!hasAnyThumbnailSource) {
      setThumbError('Informe uma URL de vídeo antes de gerar thumbnails.');
      return;
    }

    if (thumbAbortRef.current) {
      thumbAbortRef.current.abort();
    }
    const controller = new AbortController();
    thumbAbortRef.current = controller;

    if (thumbCandidatesRef.current.length > 0) {
      revokeThumbnailCandidates(thumbCandidatesRef.current);
    }
    setThumbCandidates([]);
    setSelectedThumbId(null);
    setThumbError(null);
    setThumbSourceInfo(null);
    setThumbProgress(null);
    setThumbBusy(true);

    try {
      const planRes = await adminResolveThumbnailSourceFn({
        data: {
          episodeId: editingId,
          videoUrl: form.video_url.trim() || null,
          sourceKind: form.source_kind,
        },
      });

      if (controller.signal.aborted) return;

      if (!planRes.ok) {
        setThumbError(planRes.error);
        return;
      }

      setThumbSourceInfo({
        label: planRes.plan.sourceLabel,
        blobPreferred: planRes.plan.blobPreferred,
      });

      if (!planRes.plan.ok || planRes.plan.mode === 'incompatible') {
        setThumbError(
          planRes.plan.reason ||
            'Esta fonte não permite extrair frames no navegador. Insira a URL da capa manualmente.'
        );
        return;
      }

      const extraction = await extractVideoThumbnails({
        plan: planRes.plan,
        count: 6,
        signal: controller.signal,
        onProgress: ({ completed, total }) => {
          if (!controller.signal.aborted) {
            setThumbProgress({ completed, total });
          }
        },
      });

      if (controller.signal.aborted) {
        revokeThumbnailCandidates(extraction.candidates);
        return;
      }

      if (!extraction.ok || extraction.candidates.length === 0) {
        revokeThumbnailCandidates(extraction.candidates);
        setThumbError(
          extraction.error ||
            'Não foi possível capturar imagens deste vídeo. Você pode preencher o campo de capa manualmente.'
        );
        return;
      }

      // Nunca seleciona automaticamente a primeira imagem — decisão explícita do usuário
      setThumbCandidates(extraction.candidates);
      setSelectedThumbId(null);
    } catch (err) {
      if (!controller.signal.aborted) {
        setThumbError(
          err instanceof Error ? err.message : 'Erro inesperado ao gerar thumbnails.'
        );
      }
    } finally {
      if (thumbAbortRef.current === controller) {
        thumbAbortRef.current = null;
      }
      if (!controller.signal.aborted) {
        setThumbBusy(false);
      }
    }
  };

  const handleSaveEpisode = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const trimmedPrimaryUrl = form.video_url.trim();
    if (!trimmedPrimaryUrl) {
      if (!(editingId && editingHasFallbackSources)) {
        setFormError('Informe a URL da fonte de vídeo.');
        return;
      }
    } else if (primarySourceInfo && !primarySourceInfo.check.valid) {
      setFormError(primarySourceInfo.check.error ?? 'URL da fonte de vídeo inválida.');
      return;
    }

    let openingRange: { opening_start_seconds: number | null; opening_end_seconds: number | null };
    try {
      openingRange = parseOpeningRange(form.opening_start, form.opening_end);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Horários da opening inválidos.');
      return;
    }

    setSaveBusy(true);

    try {
      let resolvedPosterUrl = form.poster_url.trim();

      if (selectedThumbnail) {
        const uploadBody = new FormData();
        uploadBody.append('file', selectedThumbnail.blob, 'thumbnail.jpg');
        uploadBody.append('animeName', sanitizeAnimeName(form.anime_name) ?? '');
        uploadBody.append('episodeId', editingId ?? '');

        const uploadResponse = await fetch('/api/thumbnails', {
          method: 'POST',
          body: uploadBody,
        });

        const uploadResult = (await uploadResponse.json().catch(() => null)) as
          | { ok: true; url: string }
          | { ok: false; error?: string }
          | null;

        if (!uploadResponse.ok || !uploadResult || !uploadResult.ok) {
          setFormError(
            uploadResult && !uploadResult.ok && uploadResult.error
              ? uploadResult.error
              : `Falha ao salvar a thumbnail selecionada (HTTP ${uploadResponse.status}).`
          );
          return;
        }

        resolvedPosterUrl = uploadResult.url;
        setForm((prev) => ({ ...prev, poster_url: uploadResult.url }));
      }

      const payload = {
        anime_name: sanitizeAnimeName(form.anime_name),
        episode_number: sanitizeEpisodeNumber(form.episode_number),
        opening_start_seconds: openingRange.opening_start_seconds,
        opening_end_seconds: openingRange.opening_end_seconds,
        title: form.title.trim(),
        poster_url: resolvedPosterUrl,
        video_url: trimmedPrimaryUrl,
        source_kind: form.source_kind,
        source_referer: form.source_referer.trim() || null,
        force_proxy: form.force_proxy,
      };

      if (editingId) {
        const res = await adminUpdateEpisodeFn({
          data: { id: editingId, ...payload },
        });
        if (!res.ok) {
          setFormError(res.error);
          return;
        }
        setSavedBanner({
          label: formatEpisodeIdentification(res.episode),
          publicUrl: res.episode.public_url,
          action: 'updated',
        });
        const targetKey = normalizeAnimeKey(res.episode.anime_name);
        setExpandedGroups((prev) => ({ ...prev, [targetKey]: true }));
        setPendingFocusGroupKey(targetKey);
      } else {
        const res = await adminCreateEpisodeFn({ data: payload });
        if (!res.ok) {
          setFormError(res.error);
          return;
        }
        setSavedBanner({
          label: formatEpisodeIdentification(res.episode),
          publicUrl: res.episode.public_url,
          action: 'created',
        });
        const targetKey = normalizeAnimeKey(res.episode.anime_name);
        setExpandedGroups((prev) => ({ ...prev, [targetKey]: true }));
        setPendingFocusGroupKey(targetKey);
      }

      syncedFormRouteKeyRef.current = null;
      setDuplicatedNotice(null);
      setForm(EMPTY_FORM);
      resetFormTestState();
      await router.invalidate();

      const openedDirectlyFromLibrary =
        lastLibraryIndexRef.current !== null &&
        router.history.location.state.__TSR_index === lastLibraryIndexRef.current + 1;
      lastLibraryIndexRef.current = null;

      executeBackPlan(
        resolvePostSaveNavigationPlan({
          canGoBack: router.history.canGoBack(),
          openedDirectlyFromLibrary,
        })
      );
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

  const handleDuplicateToDubbed = async (ep: EpisodeDto) => {
    if (duplicateLockRef.current || duplicatingEpisodeId !== null) return;
    duplicateLockRef.current = true;
    setDuplicatingEpisodeId(ep.id);
    setActionError(null);
    setFormError(null);
    setOpenMenuId(null);
    setConfirmDeleteId(null);

    try {
      const res = await adminDuplicateEpisodeFn({ data: { sourceId: ep.id } });
      if (!res.ok) {
        setActionError(res.error);
        if (formOpen) {
          setFormError(res.error);
        }
        return;
      }

      const targetKey = normalizeAnimeKey(res.episode.anime_name);
      setExpandedGroups((prev) => ({ ...prev, [targetKey]: true }));
      setPendingFocusGroupKey(targetKey);
      handleEditStart(res.episode);
      setDuplicatedNotice({
        newId: res.episode.id,
        sourceTitle: formatEpisodeIdentification(ep),
      });
      await router.invalidate().catch(() => undefined);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Erro ao duplicar episódio para dublado.';
      setActionError(message);
      if (formOpen) {
        setFormError(message);
      }
    } finally {
      duplicateLockRef.current = false;
      setDuplicatingEpisodeId(null);
    }
  };

  const handleMirrorEpisode = async (ep: EpisodeDto, hasMirror: boolean) => {
    const sourceUrl = (mirrorInputs[ep.id] ?? '').trim();
    const force = Boolean(mirrorForceMap[ep.id]);

    if (hasMirror && !force) {
      setMirrorErrorMap((prev) => ({
        ...prev,
        [ep.id]: 'Este episódio já possui espelho. Marque "Forçar refazer" para substituir.',
      }));
      return;
    }

    if (!sourceUrl) {
      setMirrorErrorMap((prev) => ({
        ...prev,
        [ep.id]: 'Informe a URL de origem (*.r2.cloudflarestorage.com ou CDN permitido).',
      }));
      return;
    }

    setMirrorBusyId(ep.id);
    setMirrorErrorMap((prev) => {
      const next = { ...prev };
      delete next[ep.id];
      return next;
    });
    setMirrorSuccessMap((prev) => {
      const next = { ...prev };
      delete next[ep.id];
      return next;
    });

    try {
      const response = await fetch('/api/mirror', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          episodeId: ep.id,
          sourceUrl,
          force,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok: true; slot: number }
        | { ok: false; error?: string }
        | null;

      if (!response.ok || !payload || !payload.ok) {
        const message =
          payload && !payload.ok && payload.error
            ? payload.error
            : `Falha ao guardar cópia (HTTP ${response.status}).`;
        setMirrorErrorMap((prev) => ({ ...prev, [ep.id]: message }));
        return;
      }

      setMirrorInputs((prev) => ({ ...prev, [ep.id]: '' }));
      setMirrorForceMap((prev) => ({ ...prev, [ep.id]: false }));
      setMirrorSuccessMap((prev) => ({
        ...prev,
        [ep.id]: `Cópia salva no Vercel Blob (Fonte ${payload.slot}).`,
      }));
      await router.invalidate();
    } catch (err) {
      setMirrorErrorMap((prev) => ({
        ...prev,
        [ep.id]: err instanceof Error ? err.message : 'Erro de rede ao guardar cópia no Blob.',
      }));
    } finally {
      setMirrorBusyId(null);
    }
  };

  const parsedBatchLines = useMemo(() => parseBatchInputLines(batchInput), [batchInput]);
  const hasBatchHashLinks = useMemo(
    () => parsedBatchLines.some((item) => !item.parseError && hasUrlHashParams(item.url)),
    [parsedBatchLines]
  );
  const hasBatchExpirableHlsLinks = useMemo(
    () =>
      parsedBatchLines.some(
        (item) => !item.parseError && isExpirableHlsSourceUrl(item.url, item.explicitKind ?? null)
      ),
    [parsedBatchLines]
  );
  const batchTotals = useMemo(
    () =>
      batchJob
        ? computeBatchTotals(batchJob.items.length, batchJob.results)
        : computeBatchTotals(0, []),
    [batchJob]
  );
  const canResumeBatch = !batchRunning && hasPendingBatchResume(batchJob);

  const executeBatchJob = async (jobToRun: BatchImportJobState, startIndex: number) => {
    setBatchError(null);
    setBatchRunning(true);
    batchStopRef.current = false;

    let currentJob: BatchImportJobState = {
      ...jobToRun,
      status: 'running',
      updatedAt: new Date().toISOString(),
    };
    setBatchJob(currentJob);
    saveBatchJobState(currentJob);

    let fatalError: string | null = null;

    const outcome = await runBatchSequence({
      items: currentJob.items,
      startIndex,
      delayMs: BATCH_ITEM_DELAY_MS,
      shouldStop: () => batchStopRef.current || Boolean(fatalError),
      processItem: async (item) => {
        const res = await adminProcessBatchItemFn({
          data: {
            ...item,
            save: currentJob.mode === 'validate_and_save',
          },
        });
        if (!res.ok) {
          fatalError = res.error;
          throw new Error(res.error);
        }
        return res.report;
      },
      onItemComplete: (idx, report: BatchItemReport) => {
        const nextResults = [...currentJob.results];
        nextResults[idx] = report;
        currentJob = {
          ...currentJob,
          lastProcessedIndex: idx,
          results: nextResults,
          status: 'running',
          updatedAt: new Date().toISOString(),
        };
        setBatchJob(currentJob);
        saveBatchJobState(currentJob);
      },
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Falha ao processar lote.';
      fatalError = msg;
      return {
        completed: false,
        lastProcessedIndex: currentJob.lastProcessedIndex,
        results: currentJob.results,
      };
    });

    const isDone = outcome.completed && currentJob.lastProcessedIndex >= currentJob.items.length - 1;
    const finalizedJob: BatchImportJobState = {
      ...currentJob,
      status: isDone ? 'completed' : 'paused',
      updatedAt: new Date().toISOString(),
    };

    setBatchJob(finalizedJob);
    saveBatchJobState(finalizedJob);
    setBatchRunning(false);

    if (fatalError) {
      setBatchError(fatalError);
    }

    if (finalizedJob.mode === 'validate_and_save' && finalizedJob.results.some((r) => r.saveStatus === 'salvo')) {
      await router.invalidate();
    }
  };

  const handleStartBatch = async (mode: BatchImportMode) => {
    if (batchRunning) return;
    setBatchError(null);

    const items = parseBatchInputLines(batchInput);
    if (items.length === 0) {
      setBatchError('Informe ao menos uma linha válida ou de item para processar.');
      return;
    }
    if (items.length > BATCH_MAX_ITEMS) {
      setBatchError(`Limite máximo de ${BATCH_MAX_ITEMS} linhas por execução excedido.`);
      return;
    }

    const newJob: BatchImportJobState = {
      id: `batch_${Date.now()}`,
      rawInput: batchInput,
      mode,
      items,
      lastProcessedIndex: -1,
      results: [],
      status: 'running',
      updatedAt: new Date().toISOString(),
    };

    await executeBatchJob(newJob, 0);
  };

  const handleResumeBatch = async () => {
    if (batchRunning || !batchJob || !hasPendingBatchResume(batchJob)) return;
    await executeBatchJob(batchJob, batchJob.lastProcessedIndex + 1);
  };

  const handlePauseBatch = () => {
    batchStopRef.current = true;
  };

  const handleClearBatchJob = () => {
    if (batchRunning) return;
    clearBatchJobState();
    setBatchJob(null);
    setBatchError(null);
  };

  const missingEnvItems: string[] = [];
  if (!initialState.databaseConfigured) missingEnvItems.push('DATABASE_URL');
  if (!initialState.passwordConfigured) missingEnvItems.push('PLAYER_ADMIN_PASSWORD');
  if (!initialState.secretConfigured) missingEnvItems.push('PLAYER_SESSION_SECRET');

  return (
    <div className="min-h-screen bg-[#090B10] text-slate-100">
      {/* Sticky Header */}
      <header className="sticky top-0 z-30 border-b border-white/[0.08] bg-[#0D1018]/90 backdrop-blur-md">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-14 sm:h-16 flex items-center justify-between gap-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-rose-600/15 border border-rose-500/30 flex items-center justify-center shrink-0">
              <Film className="w-3.5 h-3.5 text-rose-400" />
            </div>
            <span className="text-sm sm:text-base font-semibold tracking-tight text-white whitespace-nowrap shrink-0">
              Player
            </span>
            <span className="text-slate-600 hidden sm:inline" aria-hidden="true">
              /
            </span>
            <span className="text-xs sm:text-sm text-slate-400 hidden sm:inline truncate">
              Administração
            </span>
            {initialState.authenticated && (batchOpen || formOpen) && (
              <>
                <span className="text-slate-600 hidden md:inline" aria-hidden="true">
                  /
                </span>
                <span className="text-xs sm:text-sm font-medium text-slate-200 hidden md:inline truncate">
                  {batchOpen
                    ? 'Importar em lote'
                    : editingId
                      ? 'Editar episódio'
                      : 'Novo episódio'}
                </span>
              </>
            )}
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {initialState.authenticated ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    if (batchOpen) {
                      handleGoBackFromSubView();
                      return;
                    }
                    lastLibraryIndexRef.current =
                      activeView === 'library'
                        ? (router.history.location.state.__TSR_index ?? null)
                        : null;
                    void navigate({
                      to: '/admin',
                      search: { view: 'batch' },
                    });
                  }}
                  aria-pressed={batchOpen}
                  className={`min-h-[40px] sm:h-9 px-2.5 sm:px-3 rounded-xl border text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/70 ${
                    batchOpen
                      ? 'border-rose-500/50 bg-rose-600/15 text-rose-200'
                      : 'border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/[0.08] hover:text-white'
                  }`}
                >
                  <ListPlus className="w-3.5 h-3.5 shrink-0" />
                  <span className="hidden sm:inline">Importar em lote</span>
                  <span className="sm:hidden">Lote</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    if (showPlaybackDiagnostics && !playbackDiagnosticsBusy) {
                      setShowPlaybackDiagnostics(false);
                    } else {
                      void loadPlaybackDiagnostics();
                    }
                  }}
                  disabled={playbackDiagnosticsBusy}
                  aria-pressed={showPlaybackDiagnostics}
                  className={`min-h-[40px] sm:h-9 px-2.5 sm:px-3 rounded-xl border text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/70 ${
                    showPlaybackDiagnostics
                      ? 'border-white/25 bg-white/10 text-white'
                      : 'border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/[0.08] hover:text-white'
                  }`}
                  title="Diagnóstico técnico da reprodução"
                >
                  {playbackDiagnosticsBusy ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                  ) : (
                    <Activity className="w-3.5 h-3.5 shrink-0" />
                  )}
                  <span className="hidden sm:inline">Estabilidade</span>
                  <span className="sm:hidden">Player</span>
                </button>

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
                  aria-pressed={showDiagnostic}
                  className={`min-h-[40px] sm:h-9 px-2.5 sm:px-3 rounded-xl border text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/70 ${
                    showDiagnostic
                      ? 'border-white/25 bg-white/10 text-white'
                      : 'border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/[0.08] hover:text-white'
                  }`}
                  title="Diagnóstico da conexão Neon"
                >
                  {diagnosticBusy ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                  ) : (
                    <Database className="w-3.5 h-3.5 shrink-0" />
                  )}
                  <span className="hidden sm:inline">
                    {diagnosticBusy ? 'Diagnosticando...' : 'Diagnóstico Neon'}
                  </span>
                  <span className="sm:hidden">Neon</span>
                </button>

                <button
                  type="button"
                  onClick={handleLogout}
                  className="min-h-[40px] sm:h-9 px-2.5 sm:px-3 rounded-xl border border-white/10 bg-white/[0.03] text-xs font-medium text-slate-200 hover:bg-white/[0.08] hover:text-white transition-colors inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/70"
                >
                  <LogOut className="w-3.5 h-3.5 shrink-0" />
                  <span>Sair</span>
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
          <section className="bg-[#11151E] border border-amber-500/30 rounded-2xl p-4 sm:p-5">
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
          <section className="max-w-md mx-auto pt-6 sm:pt-12">
            <form
              onSubmit={handleLogin}
              className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-6 sm:p-7 space-y-5"
            >
              <div>
                <h1 className="text-xl font-semibold tracking-tight text-white">
                  Acesso administrativo
                </h1>
                <p className="mt-1.5 text-sm text-slate-400 leading-relaxed">
                  Informe a senha definida em{' '}
                  <code className="font-mono text-xs text-slate-300 bg-white/[0.05] px-1.5 py-0.5 rounded">
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
                    className="w-full h-11 px-3.5 pr-12 rounded-xl bg-[#090B10] border border-white/15 hover:border-white/25 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500 focus:ring-2 focus:ring-rose-500/20 transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                    className="absolute right-1 top-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-white/5 cursor-pointer transition-colors"
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
                <p className="text-xs sm:text-sm text-rose-400" role="alert">
                  {loginError}
                </p>
              )}

              <button
                type="submit"
                disabled={loginBusy}
                className="w-full h-11 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-60 text-sm font-medium text-white transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
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
              <div className="rounded-2xl border border-rose-500/30 bg-rose-950/30 px-4 py-3.5 text-xs sm:text-sm text-rose-300">
                {initialState.errorMessage}
              </div>
            )}

            {/* Collapsible Neon diagnostic panel */}
            {showDiagnostic && (diagnostic || diagnosticError || diagnosticBusy) && (
              <section className="rounded-2xl border border-white/[0.08] bg-[#11151E] p-4 sm:p-5 space-y-3.5">
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
                    className="w-9 h-9 flex items-center justify-center rounded-xl text-slate-400 hover:text-white hover:bg-white/5 cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {diagnosticBusy && !diagnostic && (
                  <p className="text-xs text-slate-400 inline-flex items-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Executando diagnóstico no servidor...
                  </p>
                )}

                {diagnosticError && (
                  <p className="text-xs text-rose-400" role="alert">
                    {diagnosticError}
                  </p>
                )}

                {diagnostic && (
                  <div className="space-y-3 text-xs">
                    <div
                      className={`rounded-xl border p-3 ${
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

                    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 bg-[#090B10] border border-white/[0.08] rounded-xl p-3.5 font-mono">
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
                          className={`tabular-nums ${
                            diagnostic.tableReadExecuted && !diagnostic.tableReadError
                              ? 'text-emerald-400'
                              : 'text-rose-400'
                          }`}
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
                      <div className="bg-amber-950/40 border border-amber-500/40 rounded-xl p-3 space-y-2">
                        <div className="text-xs font-semibold text-amber-200">
                          Colunas ausentes: {diagnostic.missingColumns.join(', ')}
                        </div>
                        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                          <textarea
                            readOnly
                            rows={2}
                            value={diagnostic.correctionSql ?? ''}
                            className="flex-1 w-full p-2.5 rounded-lg bg-[#090B10] border border-white/10 font-mono text-[11px] text-amber-200 select-all"
                          />
                          <button
                            type="button"
                            onClick={() => void copyLink('sql-fix', diagnostic.correctionSql ?? '')}
                            className="h-9 px-3 rounded-lg bg-amber-600 hover:bg-amber-500 text-xs font-medium text-white inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer shrink-0"
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

            {/* Collapsible Playback stability diagnostic panel */}
            {showPlaybackDiagnostics && (
              <section className="rounded-2xl border border-white/[0.08] bg-[#11151E] p-4 sm:p-5 space-y-3.5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-300 truncate">
                      Diagnóstico de estabilidade do streaming
                    </h2>
                    {playbackDiagnostics && (
                      <span className="text-[11px] font-mono text-slate-400 shrink-0">
                        {playbackDiagnostics.retainedEventsCount}/{playbackDiagnostics.maxRetainedEvents} eventos (memória)
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => void loadPlaybackDiagnostics()}
                      disabled={playbackDiagnosticsBusy}
                      className="h-8 px-2.5 rounded-lg border border-white/10 bg-white/[0.03] hover:bg-white/[0.08] text-[11px] font-medium text-slate-200 inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Atualizar
                    </button>
                    <button
                      type="button"
                      onClick={() => void clearPlaybackDiagnostics()}
                      disabled={playbackDiagnosticsBusy}
                      className="h-8 px-2.5 rounded-lg border border-white/10 bg-white/[0.03] hover:bg-white/[0.08] text-[11px] font-medium text-slate-300 inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                    >
                      Limpar
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowPlaybackDiagnostics(false)}
                      aria-label="Fechar diagnóstico de estabilidade"
                      className="w-8 h-8 flex items-center justify-center rounded-xl text-slate-400 hover:text-white hover:bg-white/5 cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {playbackDiagnosticsBusy && !playbackDiagnostics && (
                  <p className="text-xs text-slate-400 inline-flex items-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Carregando métricas de reprodução...
                  </p>
                )}

                {playbackDiagnosticsError && (
                  <p className="text-xs text-rose-400" role="alert">
                    {playbackDiagnosticsError}
                  </p>
                )}

                {playbackDiagnostics && (
                  <div className="space-y-3 text-xs">
                    {playbackDiagnostics.retainedEventsCount === 0 ? (
                      <p className="text-slate-400 bg-[#090B10] border border-white/[0.08] rounded-xl p-3.5">
                        Nenhum evento de reprodução registrado nesta instância até o momento. Os eventos são coletados sem URLs, tokens ou IPs durante o uso do player.
                      </p>
                    ) : (
                      <>
                        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 font-mono">
                          <div className="bg-[#090B10] border border-white/[0.08] rounded-xl p-3">
                            <dt className="text-[11px] text-slate-400">Iniciadas</dt>
                            <dd className="mt-1 text-sm font-semibold text-white tabular-nums">
                              {playbackDiagnostics.summary.playsStarted}
                            </dd>
                          </div>
                          <div className="bg-[#090B10] border border-white/[0.08] rounded-xl p-3">
                            <dt className="text-[11px] text-slate-400">Concluídas</dt>
                            <dd className="mt-1 text-sm font-semibold text-emerald-400 tabular-nums">
                              {playbackDiagnostics.summary.playsCompleted}
                            </dd>
                          </div>
                          <div className="bg-[#090B10] border border-white/[0.08] rounded-xl p-3">
                            <dt className="text-[11px] text-slate-400">Taxa de falhas</dt>
                            <dd className="mt-1 text-sm font-semibold text-rose-300 tabular-nums">
                              {playbackDiagnostics.summary.failureRate !== null
                                ? `${(playbackDiagnostics.summary.failureRate * 100).toFixed(1)}%`
                                : '—'}
                            </dd>
                          </div>
                          <div className="bg-[#090B10] border border-white/[0.08] rounded-xl p-3">
                            <dt className="text-[11px] text-slate-400">Início médio</dt>
                            <dd className="mt-1 text-sm font-semibold text-slate-100 tabular-nums">
                              {playbackDiagnostics.summary.averageStartupMs !== null
                                ? `${playbackDiagnostics.summary.averageStartupMs} ms`
                                : '—'}
                            </dd>
                          </div>
                          <div className="bg-[#090B10] border border-white/[0.08] rounded-xl p-3">
                            <dt className="text-[11px] text-slate-400">Buffering</dt>
                            <dd className="mt-1 text-sm font-semibold text-amber-300 tabular-nums">
                              {playbackDiagnostics.summary.bufferingCount}
                            </dd>
                          </div>
                          <div className="bg-[#090B10] border border-white/[0.08] rounded-xl p-3">
                            <dt className="text-[11px] text-slate-400">Recup. HLS OK</dt>
                            <dd className="mt-1 text-sm font-semibold text-emerald-300 tabular-nums">
                              {playbackDiagnostics.summary.hlsSuccessfulRecoveries}
                            </dd>
                          </div>
                          <div className="bg-[#090B10] border border-white/[0.08] rounded-xl p-3">
                            <dt className="text-[11px] text-slate-400">Failovers</dt>
                            <dd className="mt-1 text-sm font-semibold text-amber-300 tabular-nums">
                              {playbackDiagnostics.summary.failoverCount}
                            </dd>
                          </div>
                          <div className="bg-[#090B10] border border-white/[0.08] rounded-xl p-3">
                            <dt className="text-[11px] text-slate-400">HTTP 403/404/429/5xx</dt>
                            <dd className="mt-1 text-[11px] font-semibold text-slate-200 tabular-nums">
                              {playbackDiagnostics.summary.httpErrorsByCode[403]}/
                              {playbackDiagnostics.summary.httpErrorsByCode[404]}/
                              {playbackDiagnostics.summary.httpErrorsByCode[429]}/
                              {playbackDiagnostics.summary.httpErrorsByCode['5xx']}
                            </dd>
                          </div>
                        </dl>

                        {playbackDiagnostics.summary.topErrorCategories.length > 0 && (
                          <div className="bg-[#090B10] border border-white/[0.08] rounded-xl p-3 space-y-2">
                            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                              Categorias de fontes com mais erros
                            </div>
                            <div className="space-y-1.5">
                              {playbackDiagnostics.summary.topErrorCategories.map((cat) => (
                                <div
                                  key={cat.category}
                                  className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono"
                                >
                                  <span className="text-slate-200">{cat.label}</span>
                                  <span className="text-slate-400 tabular-nums">
                                    erros: <strong className="text-rose-300">{cat.errorCount}</strong>
                                    {' · '}failovers: {cat.failoverCount}
                                    {' · '}buffering: {cat.bufferingCount}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {playbackDiagnostics.recentEvents.length > 0 && (
                          <div className="bg-[#090B10] border border-white/[0.08] rounded-xl p-3 space-y-2">
                            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                              Últimos eventos técnicos (sanitizados)
                            </div>
                            <div className="max-h-44 overflow-y-auto space-y-1 font-mono text-[11px]">
                              {playbackDiagnostics.recentEvents.slice(0, 15).map((ev, idx) => (
                                <div
                                  key={`${ev.sessionId}-${ev.timestamp}-${ev.type}-${idx}`}
                                  className="flex flex-wrap items-center justify-between gap-2 text-slate-300 border-b border-white/[0.04] pb-1 last:border-0 last:pb-0"
                                >
                                  <span>
                                    <span className="text-slate-100">{ev.type}</span>
                                    {' · '}
                                    {PLAYBACK_SOURCE_CATEGORY_LABELS[ev.sourceCategory]} (Slot {ev.slot}
                                    {ev.deliveryMode === 'proxy' ? ' · proxy' : ''})
                                    {ev.httpStatus ? ` · HTTP ${ev.httpStatus}` : ''}
                                    {ev.errorCode ? ` · ${ev.errorCode}` : ''}
                                  </span>
                                  <span className="text-slate-500 tabular-nums">
                                    {ev.durationMs !== undefined && ev.durationMs !== null
                                      ? `${ev.durationMs}ms`
                                      : ''}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </section>
            )}

            {/* Saved episode public URL banner */}
            {savedBanner && (
              <div className="p-4 rounded-2xl bg-emerald-950/35 border border-emerald-500/30 space-y-2.5">
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
                    className="w-8 h-8 flex items-center justify-center rounded-lg text-emerald-300/70 hover:text-emerald-200 hover:bg-emerald-500/10 cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={savedBanner.publicUrl}
                    aria-label="Link público gerado"
                    className="flex-1 min-w-0 h-10 px-3 rounded-xl bg-[#090B10] border border-white/10 text-xs font-mono text-slate-200"
                  />
                  <button
                    type="button"
                    onClick={() => void copyLink('banner', savedBanner.publicUrl)}
                    className="h-10 px-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-medium text-white inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
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
              <div
                className="rounded-2xl border border-rose-500/30 bg-rose-950/30 px-4 py-3 text-xs sm:text-sm text-rose-300 flex items-center justify-between gap-3"
                role="alert"
              >
                <span>{actionError}</span>
                <button
                  type="button"
                  onClick={() => setActionError(null)}
                  aria-label="Fechar erro"
                  className="p-1 text-rose-300/70 hover:text-rose-200 cursor-pointer shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* VIEW 0: Batch Import Screen ("Importar em lote") */}
            {batchOpen ? (
              <section className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-4 sm:p-6 space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-white/[0.08]">
                  <div className="flex items-center gap-3 min-w-0">
                    <button
                      type="button"
                      onClick={handleGoBackFromSubView}
                      className="min-h-[40px] sm:h-9 px-3 rounded-xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.08] text-xs font-medium text-slate-200 inline-flex items-center gap-1.5 cursor-pointer shrink-0 transition-colors"
                    >
                      <ArrowLeft className="w-3.5 h-3.5" />
                      Voltar
                    </button>
                    <h1 className="text-base sm:text-lg font-semibold text-white truncate">
                      Importar em lote
                    </h1>
                  </div>
                  <span
                    className={`text-xs font-mono tabular-nums ${
                      parsedBatchLines.length > BATCH_MAX_ITEMS ? 'text-rose-400' : 'text-slate-400'
                    }`}
                  >
                    {parsedBatchLines.length} / {BATCH_MAX_ITEMS} linhas
                  </span>
                </div>

                <div className="space-y-2.5">
                  <label
                    htmlFor="batch-import-textarea"
                    className="block text-xs font-medium text-slate-200"
                  >
                    Lista de fontes (uma por linha)
                  </label>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Formato:{' '}
                    <code className="font-mono text-slate-200 bg-white/[0.05] px-1.5 py-0.5 rounded">
                      &lt;id_do_episodio&gt; ; &lt;url&gt; [; &lt;kind&gt;]
                    </code>
                    {' · '}kind opcional (<code className="font-mono">auto</code>,{' '}
                    <code className="font-mono">iframe</code>). Linhas vazias e comentários com{' '}
                    <code className="font-mono">#</code> são ignorados. Execução em série (1 item por vez, 400ms entre itens).
                  </p>
                  <textarea
                    id="batch-import-textarea"
                    rows={8}
                    disabled={batchRunning}
                    value={batchInput}
                    onChange={(e) => setBatchInput(e.target.value)}
                    placeholder={`# Exemplo:\nep01_id ; https://anitube22.vip/playerricas.php?id=123 ; auto\nep02_id ; https://allappinc.com/embed/abc ; iframe`}
                    className="w-full p-3.5 rounded-xl bg-[#090B10] border border-white/15 hover:border-white/25 text-xs font-mono text-white placeholder:text-slate-600 focus:outline-none focus:border-rose-500 focus:ring-2 focus:ring-rose-500/20 disabled:opacity-60 transition-colors"
                  />
                  {parsedBatchLines.length > BATCH_MAX_ITEMS && (
                    <p className="text-xs text-rose-400" role="alert">
                      Limite máximo de {BATCH_MAX_ITEMS} linhas por execução excedido ({parsedBatchLines.length} detectadas).
                    </p>
                  )}
                  {hasBatchHashLinks && (
                    <div
                      role="note"
                      className="flex items-start gap-2 rounded-xl border border-amber-500/35 bg-amber-950/30 px-3.5 py-2.5 text-xs text-amber-200"
                    >
                      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                      <span>link com hash, use sempre um link novo e não reaproveite</span>
                    </div>
                  )}
                  {hasBatchExpirableHlsLinks && (
                    <div
                      role="note"
                      className="flex items-start gap-2 rounded-xl border border-amber-500/35 bg-amber-950/30 px-3.5 py-2.5 text-xs text-amber-200"
                    >
                      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                      <span>
                        fonte HLS expirável (X-Amz-Expires, token= ou sig=): o link pode expirar depois de algum tempo
                      </span>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    disabled={
                      batchRunning ||
                      !initialState.databaseConfigured ||
                      parsedBatchLines.length === 0 ||
                      parsedBatchLines.length > BATCH_MAX_ITEMS
                    }
                    onClick={() => void handleStartBatch('validate_and_save')}
                    className="min-h-[42px] sm:h-10 px-4 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-40 text-xs sm:text-sm font-medium text-white inline-flex items-center gap-2 cursor-pointer transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                    Validar e salvar
                  </button>

                  <button
                    type="button"
                    disabled={
                      batchRunning ||
                      parsedBatchLines.length === 0 ||
                      parsedBatchLines.length > BATCH_MAX_ITEMS
                    }
                    onClick={() => void handleStartBatch('validate')}
                    className="min-h-[42px] sm:h-10 px-4 rounded-xl border border-white/15 bg-white/[0.03] hover:bg-white/[0.08] disabled:opacity-40 text-xs sm:text-sm font-medium text-slate-200 inline-flex items-center gap-2 cursor-pointer transition-colors"
                  >
                    <Activity className="w-4 h-4" />
                    Validar
                  </button>

                  {batchRunning && (
                    <button
                      type="button"
                      onClick={handlePauseBatch}
                      className="min-h-[42px] sm:h-10 px-4 rounded-xl border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-xs sm:text-sm font-medium text-amber-200 inline-flex items-center gap-2 cursor-pointer transition-colors"
                    >
                      <Pause className="w-4 h-4" />
                      Pausar
                    </button>
                  )}

                  {canResumeBatch && batchJob && (
                    <button
                      type="button"
                      onClick={() => void handleResumeBatch()}
                      className="min-h-[42px] sm:h-10 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs sm:text-sm font-medium text-white inline-flex items-center gap-2 cursor-pointer transition-colors"
                    >
                      <Play className="w-4 h-4" />
                      Continuar de onde parou (item {batchJob.lastProcessedIndex + 2}/{batchJob.items.length})
                    </button>
                  )}

                  {!batchRunning && batchJob && (
                    <button
                      type="button"
                      onClick={handleClearBatchJob}
                      className="min-h-[42px] sm:h-10 px-3.5 rounded-xl border border-white/10 text-xs text-slate-400 hover:text-white hover:bg-white/5 inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Limpar relatório
                    </button>
                  )}
                </div>

                {batchError && (
                  <p className="text-xs text-rose-400" role="alert">
                    {batchError}
                  </p>
                )}

                {batchJob && (
                  <div className="space-y-4 pt-4 border-t border-white/[0.08]">
                    {/* Progress counter */}
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="font-medium text-slate-200 tabular-nums">
                          Progresso: {batchTotals.processed} de {batchTotals.total} itens{' '}
                          <span className="text-slate-400 font-normal">
                            ({batchJob.mode === 'validate_and_save' ? 'Validar e salvar' : 'Somente validação'} ·{' '}
                            {batchRunning
                              ? 'em execução...'
                              : batchJob.status === 'completed'
                                ? 'concluído'
                                : `pausado na linha ${batchJob.lastProcessedIndex + 1}`})
                          </span>
                        </span>
                        <span className="font-mono text-slate-400 tabular-nums">
                          {batchTotals.total > 0
                            ? `${Math.round((batchTotals.processed / batchTotals.total) * 100)}%`
                            : '0%'}
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-[#090B10] overflow-hidden border border-white/10">
                        <div
                          className="h-full bg-rose-500 transition-all duration-200"
                          style={{
                            width: `${
                              batchTotals.total > 0
                                ? Math.min(100, (batchTotals.processed / batchTotals.total) * 100)
                                : 0
                            }%`,
                          }}
                        />
                      </div>
                    </div>

                    {/* Totals summary */}
                    <div className="grid grid-cols-3 divide-x divide-white/[0.08] rounded-xl bg-[#090B10] border border-white/[0.08] text-xs">
                      <div className="px-3.5 py-2.5">
                        <div className="text-slate-400">Aprovados</div>
                        <div className="text-lg font-semibold text-emerald-400 tabular-nums mt-0.5">
                          {batchTotals.aprovados}
                        </div>
                      </div>
                      <div className="px-3.5 py-2.5">
                        <div className="text-slate-400">Reprovados</div>
                        <div className="text-lg font-semibold text-rose-400 tabular-nums mt-0.5">
                          {batchTotals.reprovados}
                        </div>
                      </div>
                      <div className="px-3.5 py-2.5">
                        <div className="text-slate-400">Salvos</div>
                        <div className="text-lg font-semibold text-sky-400 tabular-nums mt-0.5">
                          {batchTotals.salvos}
                        </div>
                      </div>
                    </div>

                    {/* Report table */}
                    {batchJob.results.length > 0 && (
                      <div className="overflow-x-auto rounded-xl border border-white/[0.08] bg-[#090B10]">
                        <table className="w-full text-left border-collapse text-[11px]">
                          <thead>
                            <tr className="border-b border-white/[0.08] text-slate-400">
                              <th className="px-3 py-2.5 font-medium">Linha</th>
                              <th className="px-3 py-2.5 font-medium">ID do episódio</th>
                              <th className="px-3 py-2.5 font-medium">URL</th>
                              <th className="px-3 py-2.5 font-medium">Veredito</th>
                              <th className="px-3 py-2.5 font-medium">Salvo/Skipado</th>
                              <th className="px-3 py-2.5 font-medium">Motivo</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-white/[0.06] font-mono">
                            {batchJob.results.map((row, idx) => (
                              <tr key={`${row.lineNumber}-${idx}`} className="align-top text-slate-200">
                                <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                                  {row.lineNumber}
                                </td>
                                <td className="px-3 py-2 whitespace-nowrap">
                                  {row.episodeId || '—'}
                                </td>
                                <td className="px-3 py-2 max-w-[240px] truncate" title={row.url}>
                                  {row.url || '—'}
                                </td>
                                <td className="px-3 py-2 whitespace-nowrap">
                                  <span
                                    className={
                                      row.verdict === 'aprovado'
                                        ? 'text-emerald-400 font-semibold'
                                        : 'text-rose-400 font-semibold'
                                    }
                                  >
                                    {row.verdict}
                                  </span>
                                </td>
                                <td className="px-3 py-2 whitespace-nowrap">
                                  <span
                                    className={
                                      row.saveStatus === 'salvo'
                                        ? 'text-sky-400 font-semibold'
                                        : 'text-slate-400'
                                    }
                                  >
                                    {row.saveStatus === 'salvo' && row.savedSlot
                                      ? `salvo (Player ${row.savedSlot})`
                                      : row.saveStatus}
                                  </span>
                                </td>
                                <td className="px-3 py-2 font-sans text-slate-300">
                                  {row.reason}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </section>
            ) : formOpen ? (
              activeView === 'edit' &&
              editingId &&
              !editingEpisode &&
              syncedFormRouteKeyRef.current !== `edit:${editingId}` ? (
                <section className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-4 sm:p-6 space-y-4">
                  <div className="flex items-center gap-3 pb-4 border-b border-white/[0.08]">
                    <button
                      type="button"
                      onClick={handleCloseForm}
                      className="min-h-[40px] sm:h-9 px-3 rounded-xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.08] text-xs font-medium text-slate-200 inline-flex items-center gap-1.5 cursor-pointer shrink-0 transition-colors"
                    >
                      <ArrowLeft className="w-3.5 h-3.5" />
                      Voltar
                    </button>
                    <h1 className="text-base sm:text-lg font-semibold text-white truncate">
                      Episódio não encontrado
                    </h1>
                  </div>
                  <p className="text-xs sm:text-sm text-slate-400">
                    Este episódio não existe ou já foi removido da biblioteca.
                  </p>
                </section>
              ) : (
                /* VIEW 1: Create / Edit Episode Form */
                <section className="bg-[#11151E] border border-white/[0.08] rounded-2xl p-4 sm:p-6 space-y-6">
                  <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-white/[0.08]">
                    <div className="flex items-center gap-3 min-w-0">
                      <button
                        type="button"
                        onClick={handleCloseForm}
                        className="min-h-[40px] sm:h-9 px-3 rounded-xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.08] text-xs font-medium text-slate-200 inline-flex items-center gap-1.5 cursor-pointer shrink-0 transition-colors"
                      >
                        <ArrowLeft className="w-3.5 h-3.5" />
                        Voltar
                      </button>
                      <div className="min-w-0">
                        <h1 className="text-base sm:text-lg font-semibold text-white truncate">
                          {editingId ? 'Editar episódio' : 'Novo episódio'}
                        </h1>
                        {editingId && (
                          <p className="text-[11px] font-mono text-slate-400 truncate">
                            ID: {editingId}
                          </p>
                        )}
                      </div>
                    </div>

                    {editingId && editingEpisode && (
                      <button
                        type="button"
                        disabled={
                          duplicatingEpisodeId !== null ||
                          saveBusy ||
                          !initialState.databaseConfigured
                        }
                        onClick={() => void handleDuplicateToDubbed(editingEpisode)}
                        className="min-h-[40px] sm:h-9 px-3.5 rounded-xl border border-white/15 bg-white/[0.04] hover:bg-white/[0.09] disabled:opacity-50 text-xs font-medium text-slate-200 inline-flex items-center gap-1.5 cursor-pointer shrink-0 whitespace-nowrap transition-colors"
                      >
                        {duplicatingEpisodeId === editingEpisode.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <CopyPlus className="w-3.5 h-3.5 text-rose-400" />
                        )}
                        <span>
                          {duplicatingEpisodeId === editingEpisode.id
                            ? 'Duplicando...'
                            : 'Duplicar para dublado'}
                        </span>
                      </button>
                    )}
                  </div>

                  {duplicatedNotice && editingId === duplicatedNotice.newId && (
                    <div
                      role="status"
                      className="rounded-xl border border-emerald-500/30 bg-emerald-950/30 px-3.5 py-2.5 text-xs text-emerald-200 leading-relaxed"
                    >
                    Versão dublada criada a partir de “{duplicatedNotice.sourceTitle}” com o novo
                    ID exclusivo <code className="font-mono text-emerald-100">{duplicatedNotice.newId}</code>.
                    O episódio original permanece intacto. Insira o link do vídeo dublado no
                    Player 1 e clique em Salvar alterações.
                  </div>
                )}

                <form onSubmit={handleSaveEpisode} className="space-y-6">
                  {/* Section 1: Episode Identification */}
                  <div className="space-y-4">
                    <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Identificação do episódio
                    </h2>

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
                          onChange={(e) =>
                            setForm((prev) => ({ ...prev, anime_name: e.target.value }))
                          }
                          placeholder="Ex.: Frieren e a Jornada para o Além"
                          className="w-full h-11 px-3.5 rounded-xl bg-[#090B10] border border-white/15 hover:border-white/25 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500 focus:ring-2 focus:ring-rose-500/20 transition-colors"
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
                          onChange={(e) =>
                            setForm((prev) => ({ ...prev, episode_number: e.target.value }))
                          }
                          placeholder="Ex.: 01"
                          className="w-full h-11 px-3.5 rounded-xl bg-[#090B10] border border-white/15 hover:border-white/25 text-sm font-mono tabular-nums text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500 focus:ring-2 focus:ring-rose-500/20 transition-colors"
                        />
                      </div>
                    </div>

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
                        onChange={(e) =>
                          setForm((prev) => ({ ...prev, title: e.target.value }))
                        }
                        placeholder="Ex.: O Fim da Jornada"
                        className="w-full h-11 px-3.5 rounded-xl bg-[#090B10] border border-white/15 hover:border-white/25 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500 focus:ring-2 focus:ring-rose-500/20 transition-colors"
                      />
                    </div>
                  </div>

                  {/* Section 2: Opening timestamps (optional) */}
                  <div className="pt-5 border-t border-white/[0.08] space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                        Opening <span className="text-slate-500 font-normal lowercase">(opcional)</span>
                      </span>
                      <span className="text-[11px] font-mono text-slate-400">
                        MM:SS ou HH:MM:SS
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                          className="w-full h-11 px-3.5 rounded-xl bg-[#090B10] border border-white/15 hover:border-white/25 text-sm font-mono tabular-nums text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500 focus:ring-2 focus:ring-rose-500/20 transition-colors"
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
                          className="w-full h-11 px-3.5 rounded-xl bg-[#090B10] border border-white/15 hover:border-white/25 text-sm font-mono tabular-nums text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500 focus:ring-2 focus:ring-rose-500/20 transition-colors"
                        />
                      </div>
                    </div>

                    <p className="text-xs text-slate-400 leading-relaxed">
                      Deixe ambos os campos vazios se o episódio não tiver abertura configurada.
                    </p>
                  </div>

                  {/* Section 3: Single Video Source */}
                  <div className="pt-5 border-t border-white/[0.08] space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                        Fonte de vídeo
                      </span>
                    </div>

                    <div className="space-y-2 p-3.5 rounded-xl bg-[#090B10] border border-white/10">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-medium text-slate-300">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span>Player 1 (URL do vídeo)</span>
                          {primarySourceInfo?.normalized && (
                            <span className="px-1.5 py-0.5 rounded bg-white/[0.06] text-[10px] font-mono text-slate-300">
                              {primarySourceInfo.normalized.formatLabel}
                            </span>
                          )}
                          {primarySourceInfo?.r2Inspection.isR2 && (
                            <span
                              className={`px-1.5 py-0.5 rounded border text-[10px] font-mono ${
                                primarySourceInfo.r2Inspection.status === 'r2_unsigned'
                                  ? 'border-amber-500/40 bg-amber-950/50 text-amber-300'
                                  : 'border-amber-500/30 bg-amber-950/30 text-amber-200'
                              }`}
                            >
                              {primarySourceInfo.r2Inspection.badgeLabel}
                            </span>
                          )}
                          {primarySourceInfo?.googleVideoInspection.isGoogleVideo && (
                            <span className="px-1.5 py-0.5 rounded border border-amber-500/35 bg-amber-950/40 text-[10px] font-mono text-amber-200">
                              {primarySourceInfo.googleVideoInspection.badgeLabel}
                            </span>
                          )}
                          {primarySourceInfo?.hasHashParams && (
                            <span className="px-1.5 py-0.5 rounded border border-amber-500/35 bg-amber-950/40 text-[10px] font-mono text-amber-200">
                              link com hash
                            </span>
                          )}
                          {primarySourceInfo?.isExpirableUrl &&
                            !primarySourceInfo.r2Inspection.isR2 &&
                            !primarySourceInfo.googleVideoInspection.isGoogleVideo && (
                              <span className="px-1.5 py-0.5 rounded border border-amber-500/35 bg-amber-950/40 text-[10px] font-mono text-amber-200">
                                expirável
                              </span>
                            )}
                        </div>
                        {editingId && form.video_url.trim() && editingHasFallbackSources && (
                          <button
                            type="button"
                            onClick={handleClearPrimarySource}
                            className="text-[11px] text-rose-400 hover:text-rose-300 cursor-pointer"
                          >
                            Remover fonte
                          </button>
                        )}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
                        <input
                          type="url"
                          required={!editingHasFallbackSources}
                          value={form.video_url}
                          onChange={(e) => {
                            setForm({ ...form, video_url: e.target.value });
                            if (r2ResolveResult || r2ResolveError || r2AppliedNotice) {
                              setR2ResolveResult(null);
                              setR2ResolveError(null);
                              setR2AppliedNotice(null);
                            }
                          }}
                          placeholder="https://..."
                          className="sm:col-span-9 h-10 px-3 rounded-lg bg-[#11151E] border border-white/15 text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500 focus:ring-1 focus:ring-rose-500/20"
                        />
                        <select
                          aria-label="Tipo de fonte do Player 1"
                          value={form.source_kind}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              source_kind: e.target.value as ExplicitSourceKind | '',
                            })
                          }
                          className="sm:col-span-3 h-10 px-2.5 rounded-lg bg-[#11151E] border border-white/15 text-xs font-mono text-slate-200 focus:outline-none focus:border-rose-500"
                        >
                          <option value="">auto</option>
                          <option value="iframe">iframe</option>
                          <option value="hls">hls</option>
                          <option value="mp4">mp4</option>
                        </select>
                      </div>
                      {primarySourceInfo && !primarySourceInfo.check.valid && (
                        <p className="text-xs text-rose-400" role="alert">
                          {primarySourceInfo.check.error}
                        </p>
                      )}
                    </div>
                  
                    {editingId && !form.video_url.trim() && editingHasFallbackSources && (
                      <div
                        role="status"
                        className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 px-3.5 py-2.5 text-xs text-emerald-200 leading-relaxed"
                      >
                        Player 1 vazio neste formulário. Ao clicar em Salvar alterações, as demais
                        fontes cadastradas (como a cópia espelhada no Vercel Blob) serão mantidas e
                        a URL anterior do Player 1 não será restaurada.
                      </div>
                    )}

                    {/* Diagnostic & R2 Resolution secondary action buttons */}
                    {(primarySourceInfo?.trimmed ||
                      (primarySourceInfo?.r2Inspection.isR2 && primarySourceInfo.check.valid)) && (
                      <div className="flex flex-wrap items-center gap-2">
                        {primarySourceInfo?.trimmed && (
                          <button
                            type="button"
                            disabled={slotTesting || Boolean(!primarySourceInfo.check.valid)}
                            onClick={() => void handleTestFormPrimarySource()}
                            className="min-h-[38px] sm:h-9 px-3 rounded-xl border border-white/15 bg-white/[0.03] hover:bg-white/[0.08] disabled:opacity-40 text-xs font-medium text-slate-200 inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap transition-colors"
                          >
                            {slotTesting ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Activity className="w-3.5 h-3.5" />
                            )}
                            {slotTesting ? 'Testando...' : 'Testar fonte'}
                          </button>
                        )}

                        {primarySourceInfo?.r2Inspection.isR2 && primarySourceInfo.check.valid && (
                          <button
                            type="button"
                            disabled={r2ResolveBusy}
                            onClick={() => void handleAttemptControlledR2Resolution()}
                            title="Tenta localizar uma fonte reproduzível em playerricas.php sem alterar a URL atual automaticamente"
                            className="min-h-[38px] sm:h-9 px-3 rounded-xl border border-amber-500/40 bg-amber-950/30 hover:bg-amber-950/60 disabled:opacity-40 text-xs font-medium text-amber-200 inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap transition-colors"
                          >
                            {r2ResolveBusy ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Globe className="w-3.5 h-3.5" />
                            )}
                            {r2ResolveBusy ? 'Resolvendo R2...' : 'Tentar resolver R2'}
                          </button>
                        )}
                      </div>
                    )}

                    {form.source_referer.trim() && (
                      <div className="text-[11px] font-mono text-slate-400">
                        Referer do host:{' '}
                        <span className="text-slate-200">{form.source_referer.trim()}</span>
                      </div>
                    )}

                    <p className="text-xs text-slate-400 leading-relaxed">
                      Aceita URL direta (.m3u8, .mp4, .webm) ou página do provedor (.php, embed).
                    </p>

                    {primarySourceInfo?.check.valid && primarySourceInfo.detectedKind === 'iframe' && (
                      <div className="text-xs text-slate-200">
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
                            : primarySourceInfo.referrerPolicy === 'no-referrer'
                              ? 'iframe direto (sem Referer)'
                              : 'iframe direto'}
                        </span>
                      </div>
                    )}

                    {primarySourceInfo?.hasHashParams && (
                      <div
                        role="note"
                        className="flex items-start gap-2 rounded-xl border border-amber-500/35 bg-amber-950/30 px-3.5 py-2.5 text-xs text-amber-200"
                      >
                        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                        <span>link com hash, use sempre um link novo e não reaproveite</span>
                      </div>
                    )}

                    {primarySourceInfo?.r2Inspection.warningMessage && (
                      <div
                        role="note"
                        className="flex items-start gap-2 rounded-xl border border-amber-500/35 bg-amber-950/30 px-3.5 py-2.5 text-xs text-amber-200"
                      >
                        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                        <span>{primarySourceInfo.r2Inspection.warningMessage}</span>
                      </div>
                    )}

                    {primarySourceInfo?.googleVideoInspection.warningMessage && (
                      <div
                        role="note"
                        className="flex items-start gap-2 rounded-xl border border-amber-500/35 bg-amber-950/30 px-3.5 py-2.5 text-xs text-amber-200"
                      >
                        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                        <span>{primarySourceInfo.googleVideoInspection.warningMessage}</span>
                      </div>
                    )}

                    {(primarySourceInfo?.isExpirableUrl ||
                      (slotReport?.isExpirable &&
                        !primarySourceInfo?.r2Inspection.isR2 &&
                        !primarySourceInfo?.googleVideoInspection.isGoogleVideo)) && (
                      <div
                        role="note"
                        className="flex items-start gap-2 rounded-xl border border-amber-500/35 bg-amber-950/30 px-3.5 py-2.5 text-xs text-amber-200"
                      >
                        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                        <span>
                          {slotReport?.expirableReason ??
                            'Fonte HLS expirável: o M3U8 contém parâmetros temporários (X-Amz-Expires, token= ou sig=) e pode parar de reproduzir após expirar.'}
                        </span>
                      </div>
                    )}

                    <details className="rounded-xl bg-[#090B10] border border-white/[0.08] px-3.5 py-2.5 text-[11px] text-slate-300">
                      <summary className="cursor-pointer font-medium text-slate-300 hover:text-white select-none">
                        Regras de compatibilidade de embed
                      </summary>
                      <div className="mt-2.5 pt-2.5 border-t border-white/[0.06] space-y-1 leading-relaxed">
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
                        <div>
                          <span className="text-sky-300 font-medium">Iframe sem Referer:</span>{' '}
                          <span className="font-mono text-slate-200">
                            {EMBED_NO_REFERRER_HOSTS.join(', ')}
                          </span>
                        </div>
                      </div>
                    </details>

                    {r2ResolveError && (
                      <div
                        role="alert"
                        className="rounded-xl border border-rose-500/35 bg-rose-950/30 px-3.5 py-2.5 text-xs text-rose-200"
                      >
                        {r2ResolveError}
                      </div>
                    )}

                    {r2AppliedNotice && (
                      <div
                        role="status"
                        className="rounded-xl border border-emerald-500/35 bg-emerald-950/30 px-3.5 py-2.5 text-xs text-emerald-200"
                      >
                        {r2AppliedNotice}
                      </div>
                    )}

                    {r2ResolveResult && (
                      <div className="rounded-xl bg-[#090B10] border border-white/15 p-3.5 text-xs space-y-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={`font-semibold ${
                              r2ResolveResult.found ? 'text-emerald-300' : 'text-amber-300'
                            }`}
                          >
                            {r2ResolveResult.found
                              ? `Candidata encontrada via playerricas (${r2ResolveResult.matchedPrefix})`
                              : 'Resolução R2 sem fonte válida confirmada'}
                          </span>
                          <button
                            type="button"
                            onClick={handleDiscardR2Candidate}
                            className="text-[11px] text-slate-400 hover:text-slate-200 cursor-pointer"
                          >
                            Fechar
                          </button>
                        </div>

                        <p className="text-[11px] text-slate-300 leading-snug">
                          {r2ResolveResult.message}
                        </p>

                        {r2ResolveResult.originalUrlStatus.checked &&
                          r2ResolveResult.originalUrlStatus.message && (
                            <p className="text-[11px] font-mono text-slate-300">
                              URL original: {r2ResolveResult.originalUrlStatus.message}
                            </p>
                          )}

                        {r2ResolveResult.attempts.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {r2ResolveResult.attempts.map((attempt) => (
                              <span
                                key={attempt.prefix}
                                title={attempt.reason}
                                className={`px-2 py-0.5 rounded-md border text-[10px] font-mono ${
                                  attempt.valid
                                    ? 'border-emerald-500/40 bg-emerald-950/40 text-emerald-300'
                                    : 'border-white/10 bg-white/5 text-slate-400'
                                }`}
                              >
                                {attempt.prefix}:{' '}
                                {attempt.status !== null ? `HTTP ${attempt.status}` : 'erro/timeout'}
                              </span>
                            ))}
                          </div>
                        )}

                        {r2ResolveResult.found && r2ResolveResult.resolvedUrl && (
                          <div className="space-y-2 pt-2 border-t border-white/10">
                            <div className="text-[11px] text-slate-300">
                              Tipo detectado:{' '}
                              <span className="font-mono text-emerald-300">
                                {r2ResolveResult.detectedKind ?? 'iframe'}
                              </span>
                              {r2ResolveResult.validationDetail
                                ? ` · ${r2ResolveResult.validationDetail}`
                                : ''}
                            </div>
                            <div className="p-2.5 rounded-lg bg-black/40 border border-white/10 text-[11px] font-mono text-slate-200 break-all">
                              {r2ResolveResult.resolvedUrl}
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={handleConfirmApplyR2Candidate}
                                className="min-h-[36px] sm:h-8 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
                              >
                                <Check className="w-3.5 h-3.5" />
                                Aplicar fonte resolvida
                              </button>
                              <button
                                type="button"
                                onClick={handleDiscardR2Candidate}
                                className="min-h-[36px] sm:h-8 px-3 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-slate-200 text-xs font-medium cursor-pointer"
                              >
                                Manter URL atual
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {slotTestError && (
                      <p className="text-xs text-rose-400" role="alert">
                        {slotTestError}
                      </p>
                    )}

                    {slotReport && (
                      <div className="rounded-xl bg-[#090B10] border border-white/10 p-3.5 text-[11px] space-y-1.5 font-mono">
                        <div className="flex flex-wrap items-center justify-between gap-2">
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
                          <div className="flex items-center gap-2">
                            {slotReport.isExpirable && (
                              <span className="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-[10px] font-semibold text-amber-300">
                                expirável
                              </span>
                            )}
                            <span className="text-slate-400">
                              kind: {slotReport.detectedKind}
                            </span>
                          </div>
                        </div>
                        <p className="font-sans text-slate-300 leading-snug">
                          {slotReport.verdictReason}
                        </p>
                        {slotReport.isExpirable && slotReport.expirableReason && (
                          <p className="font-sans text-amber-300 leading-snug">
                            {slotReport.expirableReason}
                          </p>
                        )}
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
                          <div className="text-slate-200 pt-1.5 border-t border-white/10 space-y-0.5">
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

                    {/* Real Vercel Blob mirror URL details while editing */}
                    {editingId && (
                      <div className="rounded-xl bg-[#090B10] border border-white/[0.08] p-3.5 space-y-2.5">
                        {editingMirrorInfo.hasMirror && editingMirrorInfo.url ? (
                          <>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="text-xs font-medium text-emerald-300">
                                {editingMirrorInfo.isVercelBlob
                                  ? `Cópia armazenada no Vercel Blob · Fonte ${editingMirrorInfo.slot}`
                                  : `Cópia espelhada ativa · Fonte ${editingMirrorInfo.slot}`}
                              </span>
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() =>
                                    void copyLink(
                                      `form-mirror-${editingId}`,
                                      editingMirrorInfo.url!
                                    )
                                  }
                                  className="min-h-[34px] sm:h-8 px-2.5 rounded-lg border border-white/15 bg-white/[0.04] hover:bg-white/[0.09] text-[11px] font-medium text-slate-100 inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap transition-colors"
                                >
                                  {copiedId === `form-mirror-${editingId}` ? (
                                    <>
                                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                                      <span>Copiado</span>
                                    </>
                                  ) : (
                                    <>
                                      <Copy className="w-3.5 h-3.5" />
                                      <span>Copiar URL do espelho</span>
                                    </>
                                  )}
                                </button>
                                <a
                                  href={editingMirrorInfo.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="min-h-[34px] sm:h-8 px-2.5 rounded-lg border border-white/15 bg-white/[0.04] hover:bg-white/[0.09] text-[11px] font-medium text-slate-100 inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
                                >
                                  <ExternalLink className="w-3.5 h-3.5" />
                                  <span>Abrir espelho</span>
                                </a>
                              </div>
                            </div>
                            <div className="p-2.5 rounded-lg bg-black/40 border border-white/10 text-[11px] font-mono text-slate-200 break-all select-all">
                              {editingMirrorInfo.url}
                            </div>
                          </>
                        ) : (
                          <p className="text-xs text-slate-400">
                            Nenhuma cópia espelhada armazenada no Vercel Blob para este episódio.
                          </p>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Section 4: Episode poster image & manual thumbnail generator */}
                  <div className="pt-5 border-t border-white/[0.08] space-y-3.5">
                    <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Capa e thumbnails
                    </h2>

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
                        required={!selectedThumbnail}
                        value={form.poster_url}
                        onChange={(e) => {
                          setPosterPreviewError(false);
                          if (selectedThumbId !== null) {
                            setSelectedThumbId(null);
                          }
                          setForm({ ...form, poster_url: e.target.value });
                        }}
                        placeholder="https://cdn.exemplo.com/capas/ep01.jpg"
                        className="w-full h-11 px-3.5 rounded-xl bg-[#090B10] border border-white/15 hover:border-white/25 text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500 focus:ring-2 focus:ring-rose-500/20 transition-colors"
                      />
                      {posterValidation && !posterValidation.valid && !selectedThumbnail && (
                        <p className="mt-1 text-xs text-rose-400">{posterValidation.error}</p>
                      )}
                    </div>

                    {/* Visual thumbnail extraction & manual selection */}
                    <div className="rounded-xl border border-white/[0.08] bg-[#090B10]/80 p-3.5 space-y-3">
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
                            <Camera className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                            <span>Gerar thumbnails do vídeo</span>
                          </div>
                          <p className="mt-0.5 text-xs text-slate-400">
                            {thumbSourceInfo
                              ? `Fonte usada: ${thumbSourceInfo.label}.`
                              : hasBlobThumbnailSource
                                ? 'Prioridade automática: usando o vídeo armazenado no Vercel Blob.'
                                : hasAnyThumbnailSource
                                  ? 'Captura ~6 momentos do vídeo para você escolher a capa manualmente.'
                                  : 'Informe a URL do vídeo (ou gere a cópia no Vercel Blob) para extrair opções de capa.'}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 shrink-0">
                          {selectedThumbnail && (
                            <button
                              type="button"
                              onClick={() => setSelectedThumbId(null)}
                              disabled={thumbBusy || saveBusy}
                              className="min-h-[38px] sm:h-9 px-3 rounded-xl border border-white/10 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-50 cursor-pointer"
                            >
                              Limpar escolha
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void handleGenerateThumbnails()}
                            disabled={thumbBusy || saveBusy || !hasAnyThumbnailSource}
                            className="min-h-[38px] sm:h-9 px-3.5 rounded-xl border border-white/15 bg-white/[0.04] hover:bg-white/[0.08] disabled:opacity-50 text-xs font-medium text-slate-100 inline-flex items-center gap-1.5 transition-colors cursor-pointer"
                          >
                            {thumbBusy ? (
                              <>
                                <Loader2 className="w-3.5 h-3.5 animate-spin text-rose-400" />
                                {thumbProgress
                                  ? `Capturando ${thumbProgress.completed}/${thumbProgress.total}...`
                                  : 'Preparando vídeo...'}
                              </>
                            ) : (
                              <>
                                <ImageIcon className="w-3.5 h-3.5 text-rose-400" />
                                {thumbCandidates.length > 0
                                  ? 'Gerar novamente'
                                  : 'Gerar thumbnails'}
                              </>
                            )}
                          </button>
                        </div>
                      </div>

                      {thumbSourceInfo && !thumbError && (
                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                          <span className="px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-slate-300">
                            Fonte usada: {thumbSourceInfo.label}
                          </span>
                          {thumbCandidates.length > 0 && !selectedThumbnail && (
                            <span className="text-amber-300/90">
                              Clique em uma imagem abaixo para escolhê-la como capa (nenhuma é aplicada automaticamente).
                            </span>
                          )}
                        </div>
                      )}

                      {thumbError && (
                        <div
                          role="status"
                          className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 flex items-start gap-2"
                        >
                          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                          <span>{thumbError}</span>
                        </div>
                      )}

                      {thumbCandidates.length > 0 && (
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                          {thumbCandidates.map((cand, index) => {
                            const isSelected = selectedThumbId === cand.id;
                            return (
                              <button
                                key={cand.id}
                                type="button"
                                onClick={() => setSelectedThumbId(cand.id)}
                                aria-pressed={isSelected}
                                className={`group relative aspect-video rounded-xl overflow-hidden border text-left transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 ${
                                  isSelected
                                    ? 'border-rose-500 ring-2 ring-rose-500/80'
                                    : 'border-white/10 hover:border-white/30'
                                }`}
                              >
                                <img
                                  src={cand.previewUrl}
                                  alt={`Opção de thumbnail ${index + 1} (${cand.timestampLabel})`}
                                  className="w-full h-full object-cover"
                                />
                                <div className="absolute inset-x-0 bottom-0 px-2 py-1 bg-gradient-to-t from-black/85 via-black/45 to-transparent flex items-center justify-between text-[11px]">
                                  <span className="font-mono text-slate-200 tabular-nums">
                                    {cand.timestampLabel}
                                  </span>
                                  {isSelected ? (
                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-rose-600 text-white font-medium text-[10px]">
                                      <Check className="w-3 h-3" />
                                      Selecionada
                                    </span>
                                  ) : (
                                    <span className="text-[10px] text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity">
                                      Escolher
                                    </span>
                                  )}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* Poster preview */}
                    {selectedThumbnail ? (
                      <div className="space-y-1.5">
                        <div className="aspect-video max-w-sm w-full rounded-xl overflow-hidden border border-rose-500/60 bg-[#090B10] relative">
                          <img
                            src={selectedThumbnail.previewUrl}
                            alt="Prévia da thumbnail escolhida"
                            className="w-full h-full object-cover"
                          />
                          <div className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-rose-600/95 text-[11px] font-medium text-white tabular-nums">
                            Capa escolhida ({selectedThumbnail.timestampLabel})
                          </div>
                        </div>
                        <p className="text-[11px] text-slate-400">
                          Ao confirmar o salvamento, esta imagem será enviada e salva em <code className="text-slate-300">poster_url</code>.
                        </p>
                      </div>
                    ) : (
                      posterValidation?.valid &&
                      posterValidation.normalizedUrl &&
                      !posterPreviewError && (
                        <div className="aspect-video max-w-sm w-full rounded-xl overflow-hidden border border-white/10 bg-[#090B10]">
                          <img
                            {...getOptimizedImageProps(posterValidation.normalizedUrl, 'capa')}
                            alt="Prévia da imagem do episódio"
                            referrerPolicy="no-referrer"
                            onError={() => setPosterPreviewError(true)}
                            className="w-full h-full object-cover"
                          />
                        </div>
                      )
                    )}
                  </div>

                  {formError && (
                    <p className="text-sm text-rose-400" role="alert">
                      {formError}
                    </p>
                  )}

                  <div className="pt-4 border-t border-white/[0.08] flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2.5">
                    <button
                      type="button"
                      onClick={handleCloseForm}
                      className="h-11 px-4 rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] text-sm font-medium text-slate-300 cursor-pointer transition-colors"
                    >
                      Cancelar
                    </button>
                    <button
                      type="submit"
                      disabled={saveBusy || !initialState.databaseConfigured}
                      className="h-11 px-5 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-sm font-medium text-white inline-flex items-center justify-center gap-2 transition-colors cursor-pointer"
                    >
                      {saveBusy ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Check className="w-4 h-4" />
                      )}
                      {saveBusy
                        ? 'Salvando...'
                        : editingId
                          ? 'Salvar alterações'
                          : 'Cadastrar episódio'}
                    </button>
                  </div>
                </form>
              </section>
              )
            ) : (
              /* VIEW 2: Grouped Expandable & Collapsible Anime Library */
              <section className="space-y-4">
                {/* Library title + totals + primary action */}
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white">
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
                    className="h-11 sm:h-10 px-4 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-sm font-medium text-white inline-flex items-center justify-center gap-2 transition-colors cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
                  >
                    <Plus className="w-4 h-4" />
                    Novo episódio
                  </button>
                </div>

                {/* Search + Sort + Expand/Collapse controls */}
                {initialState.episodes.length > 0 && (
                  <div className="flex flex-col md:flex-row items-stretch md:items-center gap-2.5">
                    <div className="relative flex-1 min-w-0">
                      <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="search"
                        value={searchQuery}
                        onChange={(e) => {
                          setSearchQuery(e.target.value);
                          setGroupPage(1);
                        }}
                        placeholder="Pesquisar anime, episódio ou ID..."
                        aria-label="Pesquisar anime ou episódio"
                        className="w-full h-11 sm:h-10 pl-10 pr-10 rounded-xl bg-[#11151E] border border-white/[0.08] hover:border-white/20 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500 focus:ring-2 focus:ring-rose-500/20 transition-colors"
                      />
                      {searchQuery && (
                        <button
                          type="button"
                          onClick={() => {
                            setSearchQuery('');
                            setGroupPage(1);
                          }}
                          aria-label="Limpar pesquisa"
                          className="absolute right-1.5 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-white/5 cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>

                    <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 shrink-0">
                      <div
                        role="group"
                        aria-label="Ordenar animes"
                        className="flex-1 sm:flex-initial inline-flex p-1 rounded-xl bg-[#11151E] border border-white/[0.08]"
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setSortBy('recent');
                            setGroupPage(1);
                          }}
                          aria-pressed={sortBy === 'recent'}
                          className={`flex-1 sm:flex-initial px-3 min-h-[36px] sm:h-8 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                            sortBy === 'recent'
                              ? 'bg-white/10 text-white'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          Mais recentes
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setSortBy('name');
                            setGroupPage(1);
                          }}
                          aria-pressed={sortBy === 'name'}
                          className={`flex-1 sm:flex-initial px-3 min-h-[36px] sm:h-8 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                            sortBy === 'name'
                              ? 'bg-white/10 text-white'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          Nome (A–Z)
                        </button>
                      </div>

                      {pagedGroups.items.length > 0 && (
                        <button
                          type="button"
                          onClick={handleToggleAllGroups}
                          className="min-h-[44px] sm:h-10 px-3 rounded-xl border border-white/[0.08] bg-[#11151E] hover:bg-white/[0.06] text-xs font-medium text-slate-200 inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors"
                        >
                          {allVisibleExpanded ? (
                            <>
                              <ChevronsDownUp className="w-3.5 h-3.5 text-slate-400" />
                              <span>Recolher todos</span>
                            </>
                          ) : (
                            <>
                              <ChevronsUpDown className="w-3.5 h-3.5 text-slate-400" />
                              <span>Expandir todos</span>
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* Empty state, Search no-match, or Expandable Anime Groups */}
                {initialState.episodes.length === 0 ? (
                  <div className="bg-[#11151E] border border-white/[0.08] rounded-2xl px-6 py-14 text-center space-y-3">
                    <Film className="w-9 h-9 text-slate-600 mx-auto" />
                    <div>
                      <p className="text-sm font-medium text-slate-200">
                        Nenhum episódio cadastrado ainda
                      </p>
                      <p className="mt-1 text-xs text-slate-400">
                        Cadastre o primeiro episódio para organizar sua biblioteca por anime.
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={!initialState.databaseConfigured}
                      onClick={() => handleOpenCreateForm()}
                      className="h-10 px-4 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-xs font-medium text-white inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                    >
                      <Plus className="w-4 h-4" />
                      Cadastrar primeiro episódio
                    </button>
                  </div>
                ) : filteredGroups.length === 0 ? (
                  <div className="bg-[#11151E] border border-white/[0.08] rounded-2xl px-6 py-12 text-center space-y-3">
                    <p className="text-sm text-slate-300">
                      Nenhum anime ou episódio encontrado para “{searchQuery}”.
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setSearchQuery('');
                        setGroupPage(1);
                      }}
                      className="h-10 px-4 rounded-xl border border-white/10 text-xs font-medium text-slate-200 hover:bg-white/5 cursor-pointer"
                    >
                      Limpar pesquisa
                    </button>
                  </div>
                ) : (
                  <div ref={menuContainerRef} className="space-y-3">
                    {pagedGroups.items.map((group) => {
                      const expanded = isGroupExpanded(group.key);
                      const currentEpPage = episodePageMap[group.key] ?? 1;
                      const pagedGroupEpisodes = paginateItems(
                        group.episodes,
                        currentEpPage,
                        EPISODES_PER_GROUP_PAGE
                      );

                      return (
                        <article
                          key={group.key}
                          className="bg-[#11151E] border border-white/[0.08] rounded-2xl transition-colors"
                        >
                          {/* Group accordion header */}
                          <div className="flex items-center justify-between gap-2 pr-3 sm:pr-4">
                            <button
                              type="button"
                              aria-expanded={expanded}
                              onClick={() => toggleGroup(group.key)}
                              className="flex-1 min-w-0 p-3.5 sm:p-4 flex items-center gap-3.5 text-left hover:bg-white/[0.02] rounded-l-2xl cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/70 transition-colors"
                            >
                              {group.isUnassigned && !group.representativePosterUrl ? (
                                <div className="w-16 h-12 sm:w-20 sm:h-14 rounded-xl bg-[#090B10] border border-white/10 flex items-center justify-center shrink-0">
                                  <FolderOpen className="w-5 h-5 text-slate-500" />
                                </div>
                              ) : (
                                <AnimeThumbnail
                                  posterUrl={group.representativePosterUrl}
                                  alt={group.name}
                                  className="w-16 h-12 sm:w-20 sm:h-14 rounded-xl"
                                />
                              )}

                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 min-w-0">
                                  <h2
                                    className={`text-sm sm:text-base font-semibold truncate ${
                                      group.key === UNASSIGNED_ANIME_KEY
                                        ? 'text-slate-300'
                                        : 'text-white'
                                    }`}
                                  >
                                    {group.name}
                                  </h2>
                                </div>
                                <p className="mt-0.5 text-xs text-slate-400 tabular-nums truncate">
                                  {group.episodeCount}{' '}
                                  {group.episodeCount === 1 ? 'episódio' : 'episódios'}
                                  <span aria-hidden="true"> · </span>
                                  <span className="text-slate-500">
                                    {group.isUnassigned
                                      ? 'Edite para associar um anime'
                                      : `Atualizado em ${formatDatePtBr(group.latestCreatedAt)}`}
                                  </span>
                                </p>
                              </div>
                            </button>

                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                disabled={!initialState.databaseConfigured}
                                onClick={() =>
                                  handleOpenCreateForm(group.isUnassigned ? '' : group.name)
                                }
                                aria-label={`Novo episódio em ${group.name}`}
                                title={`Novo episódio em ${group.name}`}
                                className="min-h-[42px] min-w-[42px] sm:min-w-0 sm:h-9 sm:px-3 rounded-xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.08] disabled:opacity-40 text-xs font-medium text-slate-200 inline-flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap transition-colors"
                              >
                                <Plus className="w-3.5 h-3.5" />
                                <span className="hidden sm:inline">Novo episódio</span>
                              </button>

                              <button
                                type="button"
                                aria-expanded={expanded}
                                aria-label={
                                  expanded ? `Recolher ${group.name}` : `Expandir ${group.name}`
                                }
                                onClick={() => toggleGroup(group.key)}
                                className="min-h-[42px] min-w-[42px] sm:h-9 sm:w-9 rounded-xl text-slate-400 hover:text-white hover:bg-white/[0.06] inline-flex items-center justify-center cursor-pointer transition-colors"
                              >
                                <ChevronDown
                                  className={`w-4 h-4 transition-transform duration-200 ${
                                    expanded ? 'rotate-180 text-slate-200' : ''
                                  }`}
                                />
                              </button>
                            </div>
                          </div>

                          {/* Expanded Episodes List */}
                          {expanded && (
                            <div className="border-t border-white/[0.08]">
                              <ul className="divide-y divide-white/[0.06]">
                                {pagedGroupEpisodes.items.map((ep) => {
                                  const sourceCount = countEpisodeSources(ep);
                                  const isDeleting = confirmDeleteId === ep.id;
                                  const isBusyDeleting = deleteBusyId === ep.id;
                                  const isMenuOpen = openMenuId === ep.id;
                                  const hasTitle = Boolean(ep.title && ep.title.trim());
                                  const epLabel = formatEpisodeIdentification(ep);
                                  const isTesting = episodeTestingId === ep.id;
                                  const testReports = episodeTests[ep.id];
                                  const testError = episodeTestErrors[ep.id];
                                  const episodeSources = getEpisodeSourcesList(ep);
                                  const mirrorInfo = getEpisodeMirrorInfo(ep);
                                  const hasMirror = mirrorInfo.hasMirror;
                                  const forceRedo = Boolean(mirrorForceMap[ep.id]);
                                  const mirrorBlocked = hasMirror && !forceRedo;
                                  const isMirroring = mirrorBusyId === ep.id;
                                  const mirrorUrlValue = mirrorInputs[ep.id] ?? '';
                                  const mirrorError = mirrorErrorMap[ep.id];
                                  const mirrorSuccess = mirrorSuccessMap[ep.id];
                                  const isMirrorPanelOpen =
                                    Boolean(openMirrorPanelIds[ep.id]) ||
                                    isMirroring ||
                                    Boolean(mirrorError) ||
                                    Boolean(mirrorSuccess);
                                  const hasHashSource = episodeSources.some((src) =>
                                    hasUrlHashParams(src.url)
                                  );
                                  const hasExpirableSource =
                                    episodeSources.some((src) => src.isExpirable) ||
                                    Boolean(
                                      testReports?.some(
                                        (report) => report.isExpirable && !isR2StorageUrl(report.url)
                                      )
                                    );
                                  const r2Badge = episodeSources.find(
                                    (src) => src.r2Inspection.badgeLabel
                                  )?.r2Inspection.badgeLabel;
                                  const googleVideoBadge = episodeSources.find(
                                    (src) => src.googleVideoInspection.badgeLabel
                                  )?.googleVideoInspection.badgeLabel;
                                  const idCopyFeedback =
                                    episodeCopyFeedback[createEpisodeCopyKey(ep.id, 'id')];
                                  const posterCopyFeedback =
                                    episodeCopyFeedback[createEpisodeCopyKey(ep.id, 'poster')];
                                  const hasRegisteredPoster = Boolean(getEpisodeCopyPosterUrl(ep));
                                  const inlineCopyErrors = [idCopyFeedback, posterCopyFeedback].filter(
                                    (entry): entry is Extract<EpisodeCopyOutcome, { ok: false }> =>
                                      Boolean(entry && !entry.ok)
                                  );

                                  return (
                                    <li
                                      key={ep.id}
                                      className="px-3.5 sm:px-5 py-3.5 sm:py-4 hover:bg-white/[0.015] transition-colors space-y-3"
                                    >
                                      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                                        {/* Episode info */}
                                        <div className="min-w-0 flex-1 space-y-1.5">
                                          <div className="flex flex-wrap items-center gap-2 min-w-0">
                                            {ep.episode_number && (
                                              <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-white/[0.06] border border-white/10 text-xs font-mono font-semibold text-slate-100 shrink-0 tabular-nums">
                                                Ep. {ep.episode_number}
                                              </span>
                                            )}
                                            {hasTitle ? (
                                              <h3 className="text-sm font-medium text-white truncate min-w-0">
                                                {ep.title}
                                              </h3>
                                            ) : ep.episode_number ? (
                                              <h3 className="text-sm font-medium text-slate-300 truncate min-w-0">
                                                Episódio {ep.episode_number}
                                              </h3>
                                            ) : (
                                              <h3 className="text-sm font-medium text-slate-300 truncate min-w-0">
                                                {epLabel}
                                              </h3>
                                            )}
                                          </div>

                                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400 tabular-nums">
                                            <span>
                                              {sourceCount} {sourceCount === 1 ? 'fonte' : 'fontes'}
                                            </span>
                                            <span aria-hidden="true">·</span>
                                            <span>{formatDatePtBr(ep.created_at)}</span>

                                            {hasMirror && (
                                              <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-[10px] font-medium text-emerald-300">
                                                espelho
                                              </span>
                                            )}
                                            {r2Badge && (
                                              <span className="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-[10px] font-medium text-amber-300">
                                                {r2Badge}
                                              </span>
                                            )}
                                            {googleVideoBadge && (
                                              <span className="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-[10px] font-medium text-amber-300">
                                                {googleVideoBadge}
                                              </span>
                                            )}
                                            {(hasExpirableSource ||
                                              episodeSources.some(
                                                (src) =>
                                                  src.r2Inspection.isR2 ||
                                                  src.googleVideoInspection.isGoogleVideo
                                              )) && (
                                              <span className="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-[10px] font-medium text-amber-300">
                                                expirável
                                              </span>
                                            )}
                                          </div>

                                          {hasHashSource && (
                                            <p className="inline-flex items-center gap-1.5 text-[11px] text-amber-300">
                                              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                              <span>
                                                link com hash, use sempre um link novo e não reaproveite
                                              </span>
                                            </p>
                                          )}

                                          {hasExpirableSource && (
                                            <p className="inline-flex items-center gap-1.5 text-[11px] text-amber-300">
                                              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                              <span>
                                                fonte expirável: M3U8 com X-Amz-Expires, token= ou sig= pode vencer
                                              </span>
                                            </p>
                                          )}
                                        </div>

                                        {/* Episode actions */}
                                        <div className="flex items-center flex-wrap gap-1.5 shrink-0">
                                          <div className="flex items-center flex-wrap gap-1.5">
                                            <button
                                              type="button"
                                              onClick={() => void handleCopyEpisodeField(ep, 'id')}
                                              aria-label={`Copiar ID de ${epLabel}`}
                                              className={`min-h-[40px] sm:h-9 px-3 rounded-xl border text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap transition-colors ${
                                                idCopyFeedback?.ok
                                                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                                                  : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.08] text-slate-200'
                                              }`}
                                            >
                                              {idCopyFeedback?.ok ? (
                                                <>
                                                  <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                                                  <span>{idCopyFeedback.message}</span>
                                                </>
                                              ) : (
                                                <>
                                                  <Hash className="w-3.5 h-3.5 shrink-0" />
                                                  <span>Copiar ID</span>
                                                </>
                                              )}
                                            </button>

                                            <button
                                              type="button"
                                              onClick={() =>
                                                void handleCopyEpisodeField(ep, 'poster')
                                              }
                                              aria-label={`Copiar link da imagem de ${epLabel}`}
                                              title={
                                                hasRegisteredPoster
                                                  ? 'Copiar URL da thumbnail cadastrada'
                                                  : 'Sem imagem cadastrada para este episódio'
                                              }
                                              className={`min-h-[40px] sm:h-9 px-3 rounded-xl border text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap transition-colors ${
                                                posterCopyFeedback?.ok
                                                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                                                  : !hasRegisteredPoster
                                                    ? 'border-white/10 bg-white/[0.02] hover:bg-white/[0.06] text-slate-400'
                                                    : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.08] text-slate-200'
                                              }`}
                                            >
                                              {posterCopyFeedback?.ok ? (
                                                <>
                                                  <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                                                  <span>{posterCopyFeedback.message}</span>
                                                </>
                                              ) : (
                                                <>
                                                  <ImageIcon className="w-3.5 h-3.5 shrink-0" />
                                                  <span>Copiar link da imagem</span>
                                                </>
                                              )}
                                            </button>
                                          </div>

                                          <a
                                            href={`/e/${encodeURIComponent(ep.id)}`}
                                            target="_blank"
                                            rel="noreferrer"
                                            aria-label={`Abrir ${epLabel}`}
                                            className="min-h-[40px] sm:h-9 px-3 rounded-xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.08] text-xs font-medium text-slate-200 inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
                                          >
                                            <ExternalLink className="w-3.5 h-3.5" />
                                            <span>Abrir</span>
                                          </a>

                                          <button
                                            type="button"
                                            onClick={() =>
                                              setOpenMirrorPanelIds((prev) => ({
                                                ...prev,
                                                [ep.id]: !isMirrorPanelOpen,
                                              }))
                                            }
                                            aria-expanded={isMirrorPanelOpen}
                                            className={`min-h-[40px] sm:h-9 px-3 rounded-xl border text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap transition-colors ${
                                              isMirrorPanelOpen
                                                ? 'border-rose-500/40 bg-rose-600/15 text-rose-200'
                                                : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.08] text-slate-200'
                                            }`}
                                          >
                                            <Download className="w-3.5 h-3.5" />
                                            <span>Espelho</span>
                                          </button>

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
                                              className="min-h-[40px] min-w-[40px] sm:h-9 sm:w-9 rounded-xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.08] text-slate-300 hover:text-white inline-flex items-center justify-center cursor-pointer transition-colors"
                                            >
                                              <MoreVertical className="w-4 h-4" />
                                            </button>

                                            {isMenuOpen && (
                                              <div
                                                role="menu"
                                                aria-label={`Ações de ${epLabel}`}
                                                className="absolute right-0 top-full mt-1.5 z-30 w-56 rounded-xl bg-[#0D1018] border border-white/15 shadow-xl py-1"
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
                                                  disabled={
                                                    duplicatingEpisodeId !== null ||
                                                    !initialState.databaseConfigured
                                                  }
                                                  onClick={() => void handleDuplicateToDubbed(ep)}
                                                  className="w-full px-3.5 py-2.5 text-left text-xs font-medium text-slate-200 hover:bg-white/5 disabled:opacity-50 inline-flex items-center gap-2.5 cursor-pointer"
                                                >
                                                  {duplicatingEpisodeId === ep.id ? (
                                                    <Loader2 className="w-3.5 h-3.5 text-rose-400 animate-spin" />
                                                  ) : (
                                                    <CopyPlus className="w-3.5 h-3.5 text-rose-400" />
                                                  )}
                                                  {duplicatingEpisodeId === ep.id
                                                    ? 'Duplicando...'
                                                    : 'Duplicar para dublado'}
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

                                      {inlineCopyErrors.length > 0 && (
                                        <div
                                          role="status"
                                          aria-live="polite"
                                          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]"
                                        >
                                          {inlineCopyErrors.map((notice) => (
                                            <span
                                              key={createEpisodeCopyKey(
                                                notice.episodeId,
                                                notice.field
                                              )}
                                              className={
                                                notice.status === 'missing_poster'
                                                  ? 'text-amber-300'
                                                  : 'text-rose-300'
                                              }
                                            >
                                              {notice.message}
                                            </span>
                                          ))}
                                        </div>
                                      )}

                                      {/* Delete confirmation bar */}
                                      {isDeleting && (
                                        <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-rose-500/30 bg-rose-950/25 px-3.5 py-2.5">
                                          <span className="text-xs text-rose-200">
                                            Confirmar exclusão deste episódio?
                                          </span>
                                          <div className="flex items-center gap-2">
                                            <button
                                              type="button"
                                              onClick={() => setConfirmDeleteId(null)}
                                              className="min-h-[36px] sm:h-8 px-3 rounded-lg border border-white/10 text-xs text-slate-300 hover:bg-white/5 cursor-pointer"
                                            >
                                              Cancelar
                                            </button>
                                            <button
                                              type="button"
                                              disabled={isBusyDeleting}
                                              onClick={() => void handleConfirmDelete(ep.id)}
                                              className="min-h-[36px] sm:h-8 px-3 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-xs font-medium text-white cursor-pointer"
                                            >
                                              {isBusyDeleting ? 'Excluindo...' : 'Confirmar'}
                                            </button>
                                          </div>
                                        </div>
                                      )}

                                      {/* Testing feedback / diagnostic output */}
                                      {isTesting && (
                                        <p className="text-xs text-slate-400 inline-flex items-center gap-2">
                                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                          Verificando fonte no servidor...
                                        </p>
                                      )}

                                      {testError && (
                                        <div className="flex items-center justify-between gap-2 rounded-xl border border-rose-500/30 bg-rose-950/25 px-3.5 py-2 text-xs text-rose-300">
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

                                      {/* Collapsible Sources list & Vercel Blob mirror controls */}
                                      {isMirrorPanelOpen && (
                                        <div className="rounded-xl bg-[#090B10] border border-white/[0.08] p-3.5 space-y-3">
                                          <div className="flex flex-wrap items-center justify-between gap-2">
                                            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                                              Fontes do episódio
                                            </span>
                                            {mirrorInfo.hasMirror && (
                                              <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-[10px] font-medium text-emerald-300">
                                                {mirrorInfo.isVercelBlob
                                                  ? `Vercel Blob · Fonte ${mirrorInfo.slot}`
                                                  : `Espelho · Fonte ${mirrorInfo.slot}`}
                                              </span>
                                            )}
                                          </div>

                                          {mirrorInfo.hasMirror && mirrorInfo.url ? (
                                            <div className="rounded-xl bg-emerald-950/15 border border-emerald-500/25 p-3 space-y-2">
                                              <div className="flex flex-wrap items-center justify-between gap-2">
                                                <span className="text-xs font-medium text-emerald-300">
                                                  {mirrorInfo.isVercelBlob
                                                    ? `Cópia armazenada no Vercel Blob (Fonte ${mirrorInfo.slot})`
                                                    : `URL real do espelho (Fonte ${mirrorInfo.slot})`}
                                                </span>
                                                <div className="flex items-center gap-1.5">
                                                  <button
                                                    type="button"
                                                    onClick={() =>
                                                      void copyLink(
                                                        `list-mirror-${ep.id}`,
                                                        mirrorInfo.url!
                                                      )
                                                    }
                                                    className="min-h-[34px] sm:h-8 px-2.5 rounded-lg border border-white/15 bg-white/[0.04] hover:bg-white/[0.09] text-[11px] font-medium text-slate-100 inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap transition-colors"
                                                  >
                                                    {copiedId === `list-mirror-${ep.id}` ? (
                                                      <>
                                                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                                                        <span>Copiado</span>
                                                      </>
                                                    ) : (
                                                      <>
                                                        <Copy className="w-3.5 h-3.5" />
                                                        <span>Copiar URL do espelho</span>
                                                      </>
                                                    )}
                                                  </button>
                                                  <a
                                                    href={mirrorInfo.url}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="min-h-[34px] sm:h-8 px-2.5 rounded-lg border border-white/15 bg-white/[0.04] hover:bg-white/[0.09] text-[11px] font-medium text-slate-100 inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
                                                  >
                                                    <ExternalLink className="w-3.5 h-3.5" />
                                                    <span>Abrir espelho</span>
                                                  </a>
                                                </div>
                                              </div>
                                              <div className="p-2 rounded-lg bg-black/40 border border-white/10 text-[11px] font-mono text-slate-200 break-all select-all">
                                                {mirrorInfo.url}
                                              </div>
                                            </div>
                                          ) : (
                                            <p className="text-xs text-slate-400">
                                              Nenhuma cópia espelhada armazenada no Vercel Blob para
                                              este episódio.
                                            </p>
                                          )}

                                          <ul className="space-y-1.5">
                                            {episodeSources.map((src) => {
                                              const slotExpirable =
                                                src.isExpirable ||
                                                Boolean(
                                                  testReports?.find(
                                                    (report) => report.slot === src.slot
                                                  )?.isExpirable
                                                );
                                              return (
                                                <li
                                                  key={`${ep.id}-slot-${src.slot}`}
                                                  className="flex flex-wrap sm:flex-nowrap items-center gap-2 text-[11px] min-w-0"
                                                >
                                                  <span className="font-mono text-slate-300 shrink-0">
                                                    {`Fonte ${src.slot}`}
                                                  </span>
                                                  <span className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 font-mono text-[10px] text-slate-300 shrink-0">
                                                    {src.kind}
                                                  </span>
                                                  {src.isMirror && (
                                                    <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-[10px] font-semibold text-emerald-300 shrink-0">
                                                      espelho
                                                    </span>
                                                  )}
                                                  {src.r2Inspection.badgeLabel && (
                                                    <span className="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-[10px] font-semibold text-amber-300 shrink-0">
                                                      {src.r2Inspection.badgeLabel}
                                                    </span>
                                                  )}
                                                  {src.googleVideoInspection.badgeLabel && (
                                                    <span className="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-[10px] font-semibold text-amber-300 shrink-0">
                                                      {src.googleVideoInspection.badgeLabel}
                                                    </span>
                                                  )}
                                                  {(slotExpirable ||
                                                    src.r2Inspection.isR2 ||
                                                    src.googleVideoInspection.isGoogleVideo) && (
                                                    <span className="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-[10px] font-semibold text-amber-300 shrink-0">
                                                      expirável
                                                    </span>
                                                  )}
                                                  <span
                                                    className="font-mono text-slate-400 truncate min-w-0 flex-1"
                                                    title={src.url}
                                                  >
                                                    {src.url}
                                                  </span>
                                                </li>
                                              );
                                            })}
                                          </ul>

                                          <div className="pt-2.5 border-t border-white/[0.08] space-y-2.5">
                                            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                                              <input
                                                type="url"
                                                value={mirrorUrlValue}
                                                disabled={isMirroring || mirrorBlocked}
                                                onChange={(e) =>
                                                  setMirrorInputs((prev) => ({
                                                    ...prev,
                                                    [ep.id]: e.target.value,
                                                  }))
                                                }
                                                aria-label={`URL de origem para guardar cópia de ${epLabel}`}
                                                placeholder="https://...r2.cloudflarestorage.com/... (link fresco)"
                                                className="flex-1 min-w-0 h-10 sm:h-9 px-3 rounded-xl bg-[#11151E] border border-white/15 text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500 disabled:opacity-50"
                                              />
                                              <button
                                                type="button"
                                                disabled={isMirroring || mirrorBlocked}
                                                onClick={() => void handleMirrorEpisode(ep, hasMirror)}
                                                className="min-h-[40px] sm:h-9 px-3.5 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-50 disabled:cursor-not-allowed text-xs font-medium text-white inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                                              >
                                                {isMirroring ? (
                                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                ) : (
                                                  <Download className="w-3.5 h-3.5" />
                                                )}
                                                {isMirroring ? 'Guardando...' : 'Guardar cópia'}
                                              </button>
                                            </div>

                                            {hasMirror && (
                                              <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
                                                <input
                                                  type="checkbox"
                                                  checked={forceRedo}
                                                  disabled={isMirroring}
                                                  onChange={(e) =>
                                                    setMirrorForceMap((prev) => ({
                                                      ...prev,
                                                      [ep.id]: e.target.checked,
                                                    }))
                                                  }
                                                  className="rounded border-white/20 bg-[#11151E] text-rose-500 focus:ring-rose-500"
                                                />
                                                <span>
                                                  Forçar refazer espelho (episódio já possui espelho; bloqueado até marcar)
                                                </span>
                                              </label>
                                            )}

                                            {mirrorError && (
                                              <p className="text-xs text-rose-400" role="alert">
                                                {mirrorError}
                                              </p>
                                            )}

                                            {mirrorSuccess && (
                                              <p className="text-xs text-emerald-300">
                                                {mirrorSuccess}
                                              </p>
                                            )}
                                          </div>
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

                              {/* Inside-group episode pagination when an anime has > EPISODES_PER_GROUP_PAGE */}
                              {pagedGroupEpisodes.totalPages > 1 && (
                                <div className="flex flex-wrap items-center justify-between gap-2 px-4 sm:px-5 py-3 border-t border-white/[0.06] bg-[#0D1018]/60 text-xs text-slate-400">
                                  <span className="tabular-nums">
                                    Mostrando {pagedGroupEpisodes.startIndex + 1}–
                                    {pagedGroupEpisodes.endIndex} de {pagedGroupEpisodes.totalItems} episódios
                                  </span>
                                  <div className="flex items-center gap-1.5">
                                    <button
                                      type="button"
                                      disabled={pagedGroupEpisodes.page <= 1}
                                      onClick={() =>
                                        setEpisodePageMap((prev) => ({
                                          ...prev,
                                          [group.key]: Math.max(1, pagedGroupEpisodes.page - 1),
                                        }))
                                      }
                                      className="min-h-[36px] sm:h-8 px-2.5 rounded-lg border border-white/10 hover:bg-white/5 disabled:opacity-40 text-slate-200 inline-flex items-center gap-1 cursor-pointer"
                                    >
                                      <ChevronLeft className="w-3.5 h-3.5" />
                                      Anterior
                                    </button>
                                    <span className="px-2 tabular-nums font-mono text-slate-300">
                                      {pagedGroupEpisodes.page}/{pagedGroupEpisodes.totalPages}
                                    </span>
                                    <button
                                      type="button"
                                      disabled={pagedGroupEpisodes.page >= pagedGroupEpisodes.totalPages}
                                      onClick={() =>
                                        setEpisodePageMap((prev) => ({
                                          ...prev,
                                          [group.key]: Math.min(
                                            pagedGroupEpisodes.totalPages,
                                            pagedGroupEpisodes.page + 1
                                          ),
                                        }))
                                      }
                                      className="min-h-[36px] sm:h-8 px-2.5 rounded-lg border border-white/10 hover:bg-white/5 disabled:opacity-40 text-slate-200 inline-flex items-center gap-1 cursor-pointer"
                                    >
                                      Próxima
                                      <ChevronRight className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </article>
                      );
                    })}

                    {/* Group-level pagination */}
                    {pagedGroups.totalPages > 1 && (
                      <div className="flex flex-wrap items-center justify-between gap-3 pt-2 text-xs text-slate-400">
                        <span className="tabular-nums">
                          Mostrando grupos {pagedGroups.startIndex + 1}–{pagedGroups.endIndex} de{' '}
                          {pagedGroups.totalItems}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={pagedGroups.page <= 1}
                            onClick={() => setGroupPage((p) => Math.max(1, p - 1))}
                            className="min-h-[40px] sm:h-9 px-3 rounded-xl border border-white/10 bg-[#11151E] hover:bg-white/[0.06] disabled:opacity-40 text-slate-200 inline-flex items-center gap-1 cursor-pointer"
                          >
                            <ChevronLeft className="w-3.5 h-3.5" />
                            Anterior
                          </button>
                          <span className="px-2.5 font-mono tabular-nums text-slate-300">
                            Página {pagedGroups.page} de {pagedGroups.totalPages}
                          </span>
                          <button
                            type="button"
                            disabled={pagedGroups.page >= pagedGroups.totalPages}
                            onClick={() =>
                              setGroupPage((p) => Math.min(pagedGroups.totalPages, p + 1))
                            }
                            className="min-h-[40px] sm:h-9 px-3 rounded-xl border border-white/10 bg-[#11151E] hover:bg-white/[0.06] disabled:opacity-40 text-slate-200 inline-flex items-center gap-1 cursor-pointer"
                          >
                            Próxima
                            <ChevronRight className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    )}
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
            const sizeBytes =
              report.withHeaders.contentLength ?? report.noHeaders.contentLength ?? null;
            const sizeMbLabel =
              typeof sizeBytes === 'number' && sizeBytes > 0
                ? `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
                : null;
            return (
              <tr key={`${report.slot}-${report.url}`} className="align-top text-slate-200">
                <td className="px-2.5 py-2 whitespace-nowrap">
                  <div className="font-semibold text-white">{report.label}</div>
                  <div className="text-[10px] text-slate-400">
                    {report.detectedKind}
                    {sizeMbLabel ? ` · ${sizeMbLabel}` : ''}
                  </div>
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
                <td className="px-2.5 py-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`font-semibold whitespace-nowrap ${
                        report.verdict === 'direto_ok'
                          ? 'text-emerald-400'
                          : report.verdict === 'proxy_necessario'
                            ? 'text-amber-300'
                            : 'text-rose-400'
                      }`}
                    >
                      {report.verdictLabel}
                    </span>
                    {report.isExpirable && (
                      <span className="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-[10px] font-semibold text-amber-300 whitespace-nowrap">
                        expirável
                      </span>
                    )}
                  </div>
                  {report.verdictReason && (
                    <div className="text-[10px] font-sans text-slate-300 mt-0.5 max-w-[260px] leading-snug">
                      {report.verdictReason}
                    </div>
                  )}
                  {report.isExpirable && report.expirableReason && (
                    <div className="text-[10px] font-sans text-amber-300 mt-0.5 max-w-[260px] leading-snug">
                      {report.expirableReason}
                    </div>
                  )}
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


