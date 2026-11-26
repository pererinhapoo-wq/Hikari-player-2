import { createFileRoute, useRouter } from '@tanstack/react-router';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Camera,
  Check,
  ChevronRight,
  Copy,
  Database,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Film,
  FolderOpen,
  Globe,
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
import { getOptimizedImageProps } from '@/lib/image-optimization';
import { formatOpeningTimestamp, parseOpeningRange } from '@/lib/opening-skip';
import {
  adminCreateEpisodeFn,
  adminDeleteEpisodeFn,
  adminDiagnoseDatabaseFn,
  adminImportFromSiteFn,
  adminLoginFn,
  adminLogoutFn,
  adminProcessBatchItemFn,
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
  SiteImportCandidateDiagnostic,
  SourceTestReport,
} from '@/lib/types';
import {
  classifyEmbedHost,
  detectSourceKind,
  EMBED_DIRECT_HOSTS,
  EMBED_NO_REFERRER_HOSTS,
  EMBED_PROXIED_HOSTS,
  type ExplicitSourceKind,
  getIframeReferrerPolicy,
  hasUrlHashParams,
  inspectR2SourceUrl,
  isExpirableHlsSourceUrl,
  isR2StorageUrl,
  isVercelBlobUrl,
  normalizeVideoSource,
  type R2SourceInspection,
  validateHttpUrl,
} from '@/lib/video-sources';
import { extractPrefixFromPlayerricasName, isR2SignedUrl } from '@/lib/r2-resolver';

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

  // Vercel Blob mirror state per episode
  const [mirrorInputs, setMirrorInputs] = useState<Record<string, string>>({});
  const [mirrorForceMap, setMirrorForceMap] = useState<Record<string, boolean>>({});
  const [mirrorBusyId, setMirrorBusyId] = useState<string | null>(null);
  const [mirrorErrorMap, setMirrorErrorMap] = useState<Record<string, string>>({});
  const [mirrorSuccessMap, setMirrorSuccessMap] = useState<Record<string, string>>({});

  // Site import state (form + episode list)
  const [formSiteUrl, setFormSiteUrl] = useState('');
  const [formSiteImportBusy, setFormSiteImportBusy] = useState(false);
  const [formSiteImportError, setFormSiteImportError] = useState<string | null>(null);
  const [formSiteImportCandidates, setFormSiteImportCandidates] = useState<
    SiteImportCandidateDiagnostic[]
  >([]);
  const [formSiteImportNotice, setFormSiteImportNotice] = useState<string | null>(null);

  const [siteImportInputs, setSiteImportInputs] = useState<Record<string, string>>({});
  const [siteImportBusyId, setSiteImportBusyId] = useState<string | null>(null);
  const [siteImportErrorMap, setSiteImportErrorMap] = useState<Record<string, string>>({});
  const [siteImportCandidatesMap, setSiteImportCandidatesMap] = useState<
    Record<string, SiteImportCandidateDiagnostic[]>
  >({});
  const [siteImportSuccessMap, setSiteImportSuccessMap] = useState<Record<string, string>>({});

  // Neon DB diagnostic state
  const [showDiagnostic, setShowDiagnostic] = useState(false);
  const [diagnostic, setDiagnostic] = useState<DatabaseDiagnosticResult | null>(null);
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);

  // Batch import state ("Importar em lote")
  const [batchOpen, setBatchOpen] = useState(false);
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
    if (hasPendingBatchResume(saved)) {
      setBatchOpen(true);
    }
  }, []);

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
    const candidateUrl = check.normalizedUrl ?? trimmed;
    const embedHostMode = classifyEmbedHost(candidateUrl);
    const hasHashParams = hasUrlHashParams(candidateUrl);
    const isExpirableUrl = isExpirableHlsSourceUrl(candidateUrl, form.source_kind || null);
    const referrerPolicy = getIframeReferrerPolicy(candidateUrl);
    const r2Inspection = inspectR2SourceUrl(candidateUrl);
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
    resetFormTestState();
    setSelectedAnimeKey(null);
    setSearchQuery('');
    setSavedBanner(null);
    setShowDiagnostic(false);
    setDiagnostic(null);
    setDiagnosticError(null);
    await router.invalidate();
  };

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

  const resetFormTestState = () => {
    setFormError(null);
    setPosterPreviewError(false);
    setSlotTesting(false);
    setSlotReport(null);
    setSlotTestError(null);
    setFormSiteUrl('');
    setFormSiteImportBusy(false);
    setFormSiteImportError(null);
    setFormSiteImportCandidates([]);
    setFormSiteImportNotice(null);
    resetThumbnailState();
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
      source_referer: ep.source_referer ?? '',
      force_proxy: ep.force_proxy !== false,
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

  const handleImportSiteIntoForm = async () => {
    const pageUrl = formSiteUrl.trim();
    if (!pageUrl) {
      setFormSiteImportError('Informe a URL da página do episódio (anitube.biz, anitube22.vip ou allappinc.com).');
      return;
    }
    setFormSiteImportBusy(true);
    setFormSiteImportError(null);
    setFormSiteImportCandidates([]);
    setFormSiteImportNotice(null);
    setSlotTestError(null);

    try {
      const res = await adminImportFromSiteFn({
        data: {
          pageUrl,
          episodeId: editingId,
          targetSlot: editingId ? 1 : null,
        },
      });

      if (!res.ok) {
        setFormSiteImportError(res.error);
        setFormSiteImportCandidates(res.candidates);
        return;
      }

      setForm((prev) => ({
        ...prev,
        title: prev.title.trim() ? prev.title : res.extractedTitle ?? prev.title,
        poster_url: prev.poster_url.trim() ? prev.poster_url : res.extractedPoster ?? prev.poster_url,
        video_url: res.selected.url,
        source_kind: res.selected.kind,
        source_referer: res.selected.hostReferer,
        force_proxy: true,
      }));
      setFormSiteImportCandidates(res.candidates);
      setSlotReport(res.testReport);

      const expirableWarn = res.selected.isExpirable
        ? ` Atenção: ${res.selected.expirableReason ?? 'fonte expirável detectada.'}`
        : '';
      setFormSiteImportNotice(
        res.saved
          ? `Fonte gravada no Player ${res.slot ?? 1} (${res.selected.kind}, proxy ativo, referer ${res.selected.hostReferer || 'vazio'}) e testada.${expirableWarn}`
          : `Fonte importada para o formulário (${res.selected.kind}, proxy ativo, referer ${res.selected.hostReferer || 'vazio'}) e testada.${expirableWarn}`
      );

      if (res.saved) {
        await router.invalidate();
      }
    } catch (err) {
      setFormSiteImportError(
        err instanceof Error ? err.message : 'Falha ao importar fonte da página.'
      );
    } finally {
      setFormSiteImportBusy(false);
    }
  };

  const handleImportSiteForEpisode = async (ep: EpisodeDto) => {
    const pageUrl = (siteImportInputs[ep.id] ?? '').trim();
    if (!pageUrl) {
      setSiteImportErrorMap((prev) => ({
        ...prev,
        [ep.id]: 'Informe a URL da página do episódio (anitube.biz, anitube22.vip ou allappinc.com).',
      }));
      return;
    }

    setSiteImportBusyId(ep.id);
    setSiteImportErrorMap((prev) => {
      const next = { ...prev };
      delete next[ep.id];
      return next;
    });
    setSiteImportCandidatesMap((prev) => {
      const next = { ...prev };
      delete next[ep.id];
      return next;
    });
    setSiteImportSuccessMap((prev) => {
      const next = { ...prev };
      delete next[ep.id];
      return next;
    });

    try {
      const res = await adminImportFromSiteFn({
        data: {
          pageUrl,
          episodeId: ep.id,
        },
      });

      if (!res.ok) {
        setSiteImportErrorMap((prev) => ({ ...prev, [ep.id]: res.error }));
        setSiteImportCandidatesMap((prev) => ({ ...prev, [ep.id]: res.candidates }));
        return;
      }

      setSiteImportInputs((prev) => ({ ...prev, [ep.id]: '' }));
      setSiteImportCandidatesMap((prev) => ({ ...prev, [ep.id]: res.candidates }));
      const expirableWarn = res.selected.isExpirable
        ? ` Atenção: ${res.selected.expirableReason ?? 'fonte expirável.'}`
        : '';
      setSiteImportSuccessMap((prev) => ({
        ...prev,
        [ep.id]: `Fonte ${res.slot ?? 1} gravada (${res.selected.kind}, force_proxy=true, referer ${res.selected.hostReferer || 'vazio'}).${expirableWarn}`,
      }));
      setEpisodeTests((prev) => ({
        ...prev,
        [ep.id]: [res.testReport],
      }));
      await router.invalidate();
    } catch (err) {
      setSiteImportErrorMap((prev) => ({
        ...prev,
        [ep.id]: err instanceof Error ? err.message : 'Falha ao importar fonte da página.',
      }));
    } finally {
      setSiteImportBusyId(null);
    }
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

  const editingEpisodeSources = useMemo(() => {
    if (!editingId) return [];
    const ep = initialState.episodes.find((item) => item.id === editingId);
    return ep ? getEpisodeSourcesList(ep) : [];
  }, [editingId, initialState.episodes]);

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
        episode_number: form.episode_number.trim() || null,
        opening_start_seconds: openingRange.opening_start_seconds,
        opening_end_seconds: openingRange.opening_end_seconds,
        title: form.title.trim(),
        poster_url: resolvedPosterUrl,
        video_url: form.video_url.trim(),
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
                    setFormOpen(false);
                    setBatchOpen((prev) => !prev);
                  }}
                  className={`h-9 px-2.5 sm:px-3 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                    batchOpen
                      ? 'border-rose-500/60 bg-rose-600/15 text-rose-200'
                      : 'border-white/10 text-slate-300 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  <ListPlus className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Importar em lote</span>
                  <span className="sm:hidden">Lote</span>
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

            {/* VIEW 0: Batch Import Screen ("Importar em lote") */}
            {batchOpen ? (
              <section className="bg-[#11151E] border border-white/10 rounded-xl p-4 sm:p-6 space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-white/10">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <button
                      type="button"
                      onClick={() => setBatchOpen(false)}
                      className="h-9 px-2.5 rounded-lg border border-white/10 text-xs font-medium text-slate-200 hover:bg-white/5 inline-flex items-center gap-1.5 cursor-pointer shrink-0"
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

                <div className="space-y-2">
                  <label
                    htmlFor="batch-import-textarea"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Lista de fontes (uma por linha)
                  </label>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    Formato: <code className="font-mono text-slate-200">&lt;id_do_episodio&gt; ; &lt;url&gt; [; &lt;kind&gt;]</code>
                    {' · '}kind opcional (<code className="font-mono">auto</code>, <code className="font-mono">iframe</code>). Linhas vazias e comentários com <code className="font-mono">#</code> são ignorados. Execução em série (1 item por vez, 400ms entre itens).
                  </p>
                  <textarea
                    id="batch-import-textarea"
                    rows={8}
                    disabled={batchRunning}
                    value={batchInput}
                    onChange={(e) => setBatchInput(e.target.value)}
                    placeholder={`# Exemplo:\nep01_id ; https://anitube22.vip/playerricas.php?id=123 ; auto\nep02_id ; https://allappinc.com/embed/abc ; iframe`}
                    className="w-full p-3 rounded-lg bg-[#090B10] border border-white/15 text-xs font-mono text-white placeholder:text-slate-600 focus:outline-none focus:border-rose-500 disabled:opacity-60"
                  />
                  {parsedBatchLines.length > BATCH_MAX_ITEMS && (
                    <p className="text-xs text-rose-400" role="alert">
                      Limite máximo de {BATCH_MAX_ITEMS} linhas por execução excedido ({parsedBatchLines.length} detectadas).
                    </p>
                  )}
                  {hasBatchHashLinks && (
                    <div
                      role="note"
                      className="flex items-start gap-2 rounded-lg border border-amber-500/35 bg-amber-950/30 px-3 py-2 text-xs text-amber-200"
                    >
                      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                      <span>link com hash, use sempre um link novo e não reaproveite</span>
                    </div>
                  )}
                  {hasBatchExpirableHlsLinks && (
                    <div
                      role="note"
                      className="flex items-start gap-2 rounded-lg border border-amber-500/35 bg-amber-950/30 px-3 py-2 text-xs text-amber-200"
                    >
                      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                      <span>fonte HLS expirável (X-Amz-Expires, token= ou sig=): o link pode expirar depois de algum tempo</span>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    disabled={
                      batchRunning ||
                      parsedBatchLines.length === 0 ||
                      parsedBatchLines.length > BATCH_MAX_ITEMS
                    }
                    onClick={() => void handleStartBatch('validate')}
                    className="h-10 px-4 rounded-lg border border-white/15 bg-[#090B10] hover:bg-white/5 disabled:opacity-40 text-xs sm:text-sm font-medium text-slate-200 inline-flex items-center gap-2 cursor-pointer"
                  >
                    <Activity className="w-4 h-4" />
                    Validar
                  </button>

                  <button
                    type="button"
                    disabled={
                      batchRunning ||
                      !initialState.databaseConfigured ||
                      parsedBatchLines.length === 0 ||
                      parsedBatchLines.length > BATCH_MAX_ITEMS
                    }
                    onClick={() => void handleStartBatch('validate_and_save')}
                    className="h-10 px-4 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-40 text-xs sm:text-sm font-medium text-white inline-flex items-center gap-2 cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                    Validar e salvar
                  </button>

                  {batchRunning && (
                    <button
                      type="button"
                      onClick={handlePauseBatch}
                      className="h-10 px-4 rounded-lg border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-xs sm:text-sm font-medium text-amber-200 inline-flex items-center gap-2 cursor-pointer"
                    >
                      <Pause className="w-4 h-4" />
                      Pausar
                    </button>
                  )}

                  {canResumeBatch && batchJob && (
                    <button
                      type="button"
                      onClick={() => void handleResumeBatch()}
                      className="h-10 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs sm:text-sm font-medium text-white inline-flex items-center gap-2 cursor-pointer"
                    >
                      <Play className="w-4 h-4" />
                      Continuar de onde parou (item {batchJob.lastProcessedIndex + 2}/{batchJob.items.length})
                    </button>
                  )}

                  {!batchRunning && batchJob && (
                    <button
                      type="button"
                      onClick={handleClearBatchJob}
                      className="h-10 px-3 rounded-lg border border-white/10 text-xs text-slate-400 hover:text-white hover:bg-white/5 inline-flex items-center gap-1.5 cursor-pointer"
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
                  <div className="space-y-4 pt-2 border-t border-white/10">
                    {/* Progress counter */}
                    <div className="space-y-1.5">
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

                    {/* Totals */}
                    <div className="grid grid-cols-3 gap-3 text-xs">
                      <div className="rounded-lg bg-[#090B10] border border-white/10 px-3 py-2.5">
                        <div className="text-slate-400">Aprovados</div>
                        <div className="text-lg font-semibold text-emerald-400 tabular-nums">
                          {batchTotals.aprovados}
                        </div>
                      </div>
                      <div className="rounded-lg bg-[#090B10] border border-white/10 px-3 py-2.5">
                        <div className="text-slate-400">Reprovados</div>
                        <div className="text-lg font-semibold text-rose-400 tabular-nums">
                          {batchTotals.reprovados}
                        </div>
                      </div>
                      <div className="rounded-lg bg-[#090B10] border border-white/10 px-3 py-2.5">
                        <div className="text-slate-400">Salvos</div>
                        <div className="text-lg font-semibold text-sky-400 tabular-nums">
                          {batchTotals.salvos}
                        </div>
                      </div>
                    </div>

                    {/* Report table */}
                    {batchJob.results.length > 0 && (
                      <div className="overflow-x-auto rounded-lg border border-white/10 bg-[#090B10]">
                        <table className="w-full text-left border-collapse text-[11px]">
                          <thead>
                            <tr className="border-b border-white/10 text-slate-400">
                              <th className="px-2.5 py-2 font-medium">Linha</th>
                              <th className="px-2.5 py-2 font-medium">ID do episódio</th>
                              <th className="px-2.5 py-2 font-medium">URL</th>
                              <th className="px-2.5 py-2 font-medium">Veredito</th>
                              <th className="px-2.5 py-2 font-medium">Salvo/Skipado</th>
                              <th className="px-2.5 py-2 font-medium">Motivo</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-white/10 font-mono">
                            {batchJob.results.map((row, idx) => (
                              <tr key={`${row.lineNumber}-${idx}`} className="align-top text-slate-200">
                                <td className="px-2.5 py-2 tabular-nums whitespace-nowrap">
                                  {row.lineNumber}
                                </td>
                                <td className="px-2.5 py-2 whitespace-nowrap">
                                  {row.episodeId || '—'}
                                </td>
                                <td className="px-2.5 py-2 max-w-[240px] truncate" title={row.url}>
                                  {row.url || '—'}
                                </td>
                                <td className="px-2.5 py-2 whitespace-nowrap">
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
                                <td className="px-2.5 py-2 whitespace-nowrap">
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
                                <td className="px-2.5 py-2 font-sans text-slate-300">
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

                  {/* Importar fonte a partir da página do episódio */}
                  <div className="pt-2 border-t border-white/10 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label
                        htmlFor="ep-site-page-url"
                        className="text-xs font-medium text-slate-200 inline-flex items-center gap-1.5"
                      >
                        <Globe className="w-3.5 h-3.5 text-rose-400" />
                        URL da página do episódio (anitube.biz / anitube22.vip / allappinc.com)
                      </label>
                      <span className="text-[11px] text-slate-400">
                        Extrai e valida playerricas.php → /index.m3u8 → .mp4
                      </span>
                    </div>

                    <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                      <input
                        id="ep-site-page-url"
                        type="url"
                        disabled={formSiteImportBusy}
                        value={formSiteUrl}
                        onChange={(e) => setFormSiteUrl(e.target.value)}
                        placeholder="https://www.anitube.biz/episodio-01/ ou https://allappinc.com/?view=..."
                        className="flex-1 min-w-0 h-11 px-3 rounded-lg bg-[#090B10] border border-white/15 text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500 disabled:opacity-50"
                      />
                      <button
                        type="button"
                        disabled={formSiteImportBusy || !formSiteUrl.trim()}
                        onClick={() => void handleImportSiteIntoForm()}
                        className="h-11 px-4 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 disabled:opacity-40 text-xs font-medium text-white inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        {formSiteImportBusy ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-rose-400" />
                            Importando...
                          </>
                        ) : (
                          <>
                            <Download className="w-3.5 h-3.5 text-rose-400" />
                            Importar do site
                          </>
                        )}
                      </button>
                    </div>

                    {formSiteImportError && (
                      <div
                        role="alert"
                        className="rounded-lg border border-rose-500/35 bg-rose-950/30 px-3 py-2 text-xs text-rose-200 space-y-1.5"
                      >
                        <p className="font-medium text-rose-300">{formSiteImportError}</p>
                        {formSiteImportCandidates.length > 0 && (
                          <SiteImportCandidateList candidates={formSiteImportCandidates} />
                        )}
                      </div>
                    )}

                    {formSiteImportNotice && (
                      <div className="rounded-lg border border-emerald-500/35 bg-emerald-950/25 px-3 py-2 text-xs text-emerald-200 space-y-1.5">
                        <p>{formSiteImportNotice}</p>
                        {formSiteImportCandidates.length > 0 && (
                          <SiteImportCandidateList candidates={formSiteImportCandidates} />
                        )}
                      </div>
                    )}
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
                        {primarySourceInfo?.isUnconfirmed ? (
                          <span className="text-[11px] font-mono text-amber-300 bg-amber-950/40 px-1.5 py-0.5 rounded border border-amber-500/30">
                            prefixo não confirmado
                          </span>
                        ) : primarySourceInfo?.detectedPrefix ? (
                          <span className="text-[11px] font-mono text-cyan-300">
                            Prefixo: {primarySourceInfo.detectedPrefix}
                          </span>
                        ) : null}
                        {primarySourceInfo?.isR2 && !primarySourceInfo?.trimmed.includes('unconfirmed=1') && (
                          <span className="text-[11px] font-mono text-amber-300" title="URL assinada do R2: prefixo verificado por tentativa ao salvar/testar">
                            R2 Signed URL (tentativa automática)
                          </span>
                        )}
                        {primarySourceInfo?.r2Inspection.status === 'r2_unsigned' && (
                          <span className="text-[11px] font-mono text-amber-300 bg-amber-950/40 px-1.5 py-0.5 rounded border border-amber-500/30">
                            {primarySourceInfo.r2Inspection.badgeLabel}
                          </span>
                        )}
                        {primarySourceInfo?.detectedKind && (
                          <span className="text-[11px] font-mono text-emerald-300">
                            {primarySourceInfo.detectedKind}
                          </span>
                        )}
                        {(primarySourceInfo?.isExpirableUrl ||
                          primarySourceInfo?.r2Inspection.isR2 ||
                          slotReport?.isExpirable) && (
                          <span className="text-[11px] font-mono text-amber-300 bg-amber-950/40 px-1.5 py-0.5 rounded border border-amber-500/30">
                            fonte expirável
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

                    {form.source_referer.trim() && (
                      <div className="text-[11px] font-mono text-slate-400">
                        Referer do host:{' '}
                        <span className="text-slate-200">{form.source_referer.trim()}</span>
                      </div>
                    )}

                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      Aceita URL direta (.m3u8, .mp4, .webm) ou página do provedor (.php, embed).
                    </p>

                    {primarySourceInfo?.hasHashParams && (
                      <div
                        role="note"
                        className="flex items-start gap-2 rounded-lg border border-amber-500/35 bg-amber-950/30 px-3 py-2 text-xs text-amber-200"
                      >
                        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                        <span>link com hash, use sempre um link novo e não reaproveite</span>
                      </div>
                    )}

                    {primarySourceInfo?.r2Inspection.warningMessage && (
                      <div
                        role="note"
                        className="flex items-start gap-2 rounded-lg border border-amber-500/35 bg-amber-950/30 px-3 py-2 text-xs text-amber-200"
                      >
                        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                        <span>{primarySourceInfo.r2Inspection.warningMessage}</span>
                      </div>
                    )}

                    {(primarySourceInfo?.isExpirableUrl ||
                      (slotReport?.isExpirable && !primarySourceInfo?.r2Inspection.isR2)) && (
                      <div
                        role="note"
                        className="flex items-start gap-2 rounded-lg border border-amber-500/35 bg-amber-950/30 px-3 py-2 text-xs text-amber-200"
                      >
                        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                        <span>
                          {slotReport?.expirableReason ??
                            'Fonte HLS expirável: o M3U8 contém parâmetros temporários (X-Amz-Expires, token= ou sig=) e pode parar de reproduzir após expirar.'}
                        </span>
                      </div>
                    )}

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
                      <div>
                        <span className="text-sky-300 font-medium">Iframe sem Referer:</span>{' '}
                        <span className="font-mono text-slate-200">
                          {EMBED_NO_REFERRER_HOSTS.join(', ')}
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
                                : primarySourceInfo.referrerPolicy === 'no-referrer'
                                  ? 'iframe direto (sem Referer)'
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

                  {/* Episode poster image & manual thumbnail generator */}
                  <div className="space-y-3">
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
                        className="w-full h-11 px-3 rounded-lg bg-[#090B10] border border-white/15 text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500"
                      />
                      {posterValidation && !posterValidation.valid && !selectedThumbnail && (
                        <p className="mt-1 text-xs text-rose-400">{posterValidation.error}</p>
                      )}
                    </div>

                    {/* Visual thumbnail extraction & manual selection */}
                    <div className="rounded-lg border border-white/10 bg-[#090B10]/80 p-3 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
                            <Camera className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                            <span>Gerar thumbnails do vídeo</span>
                          </div>
                          <p className="mt-0.5 text-[11px] text-slate-400">
                            {thumbSourceInfo
                              ? `Fonte usada: ${thumbSourceInfo.label}.`
                              : hasBlobThumbnailSource
                                ? 'Prioridade automática: usando o vídeo armazenado no Vercel Blob.'
                                : hasAnyThumbnailSource
                                  ? 'Captura ~6 momentos do vídeo para você escolher a capa manualmente.'
                                  : 'Informe a URL do vídeo (ou gere a cópia no Vercel Blob) para extrair opções de capa.'}
                          </p>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {selectedThumbnail && (
                            <button
                              type="button"
                              onClick={() => setSelectedThumbId(null)}
                              disabled={thumbBusy || saveBusy}
                              className="h-9 px-2.5 rounded-lg border border-white/10 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-50 cursor-pointer"
                            >
                              Limpar escolha
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void handleGenerateThumbnails()}
                            disabled={thumbBusy || saveBusy || !hasAnyThumbnailSource}
                            className="h-9 px-3 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 disabled:opacity-50 text-xs font-medium text-slate-100 inline-flex items-center gap-1.5 transition-colors cursor-pointer"
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
                          <span className="px-2 py-0.5 rounded bg-white/5 border border-white/10 text-slate-300">
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
                          className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 flex items-start gap-2"
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
                                className={`group relative aspect-video rounded-lg overflow-hidden border text-left transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 ${
                                  isSelected
                                    ? 'border-rose-500 ring-2 ring-rose-500/80 shadow-lg shadow-rose-950/40'
                                    : 'border-white/10 hover:border-white/30'
                                }`}
                              >
                                <img
                                  src={cand.previewUrl}
                                  alt={`Opção de thumbnail ${index + 1} (${cand.timestampLabel})`}
                                  className="w-full h-full object-cover"
                                />
                                <div className="absolute inset-x-0 bottom-0 px-2 py-1 bg-gradient-to-t from-black/85 via-black/45 to-transparent flex items-center justify-between text-[11px]">
                                  <span className="font-mono text-slate-200">
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

                    {/* Poster preview: shows explicitly chosen thumbnail or saved/typed poster_url */}
                    {selectedThumbnail ? (
                      <div className="space-y-1.5">
                        <div className="aspect-video max-w-sm w-full rounded-lg overflow-hidden border border-rose-500/60 bg-[#090B10] relative">
                          <img
                            src={selectedThumbnail.previewUrl}
                            alt="Prévia da thumbnail escolhida"
                            className="w-full h-full object-cover"
                          />
                          <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-rose-600/95 text-[11px] font-medium text-white">
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
                        <div className="aspect-video max-w-sm w-full rounded-lg overflow-hidden border border-white/10 bg-[#090B10]">
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
                      const episodeSources = getEpisodeSourcesList(ep);
                      const hasMirror = episodeSources.some((src) => src.isMirror);
                      const forceRedo = Boolean(mirrorForceMap[ep.id]);
                      const mirrorBlocked = hasMirror && !forceRedo;
                      const isMirroring = mirrorBusyId === ep.id;
                      const mirrorUrlValue = mirrorInputs[ep.id] ?? '';
                      const mirrorError = mirrorErrorMap[ep.id];
                      const mirrorSuccess = mirrorSuccessMap[ep.id];
                      const hasHashSource = episodeSources.some((src) =>
                        hasUrlHashParams(src.url)
                      );
                      const hasExpirableSource =
                        episodeSources.some((src) => src.isExpirable) ||
                        Boolean(testReports?.some((report) => report.isExpirable && !isR2StorageUrl(report.url)));
                      const r2EpisodeInspection =
                        episodeSources.find((src) => src.r2Inspection.status === 'r2_unsigned')
                          ?.r2Inspection ??
                        episodeSources.find((src) => src.r2Inspection.isR2)?.r2Inspection ??
                        null;

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

                              {hasHashSource && (
                                <p className="inline-flex items-center gap-1.5 text-[11px] text-amber-300">
                                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                  <span>link com hash, use sempre um link novo e não reaproveite</span>
                                </p>
                              )}

                              {r2EpisodeInspection?.warningMessage && (
                                <p className="inline-flex items-start gap-1.5 text-[11px] text-amber-300">
                                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                                  <span>{r2EpisodeInspection.warningMessage}</span>
                                </p>
                              )}

                              {hasExpirableSource && (
                                <p className="inline-flex items-center gap-1.5 text-[11px] text-amber-300">
                                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                  <span>fonte expirável: M3U8 com X-Amz-Expires, token= ou sig= pode vencer</span>
                                </p>
                              )}
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

                          {/* Sources list & Vercel Blob mirror controls */}
                          <div className="rounded-lg bg-[#090B10] border border-white/10 p-3 space-y-2.5">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                                Fontes do episódio
                              </span>
                              {hasMirror && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-[10px] font-medium text-emerald-300">
                                  espelho ativo
                                </span>
                              )}
                            </div>

                            <ul className="space-y-1.5">
                              {episodeSources.map((src) => {
                                const slotExpirable =
                                  src.isExpirable ||
                                  Boolean(
                                    testReports?.find((report) => report.slot === src.slot)
                                      ?.isExpirable
                                  );
                                return (
                                  <li
                                    key={`${ep.id}-slot-${src.slot}`}
                                    className="flex items-center gap-2 text-[11px] min-w-0"
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
                                    {(slotExpirable || src.r2Inspection.isR2) && (
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

                            <div className="pt-2 border-t border-white/10 space-y-2">
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
                                  className="flex-1 min-w-0 h-9 px-3 rounded-lg bg-[#11151E] border border-white/15 text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500 disabled:opacity-50"
                                />
                                <button
                                  type="button"
                                  disabled={isMirroring || mirrorBlocked}
                                  onClick={() => void handleMirrorEpisode(ep, hasMirror)}
                                  className="h-9 px-3 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 disabled:cursor-not-allowed text-xs font-medium text-white inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                                >
                                  <Download className="w-3.5 h-3.5" />
                                  {isMirroring ? 'Guardando...' : 'Guardar cópia'}
                                </button>
                              </div>

                              {hasMirror && (
                                <label className="inline-flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer select-none">
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

                            {/* Importar do site diretamente no episódio */}
                            <div className="pt-2 border-t border-white/10 space-y-2">
                              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                                <input
                                  type="url"
                                  value={siteImportInputs[ep.id] ?? ''}
                                  disabled={siteImportBusyId === ep.id}
                                  onChange={(e) =>
                                    setSiteImportInputs((prev) => ({
                                      ...prev,
                                      [ep.id]: e.target.value,
                                    }))
                                  }
                                  aria-label={`URL da página do episódio para importar em ${epLabel}`}
                                  placeholder="https://www.anitube.biz/..., anitube22.vip/... ou allappinc.com/?view=..."
                                  className="flex-1 min-w-0 h-9 px-3 rounded-lg bg-[#11151E] border border-white/15 text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500 disabled:opacity-50"
                                />
                                <button
                                  type="button"
                                  disabled={
                                    siteImportBusyId === ep.id ||
                                    !(siteImportInputs[ep.id] ?? '').trim()
                                  }
                                  onClick={() => void handleImportSiteForEpisode(ep)}
                                  className="h-9 px-3 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed text-xs font-medium text-white inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                                >
                                  <Globe className="w-3.5 h-3.5 text-rose-400" />
                                  {siteImportBusyId === ep.id
                                    ? 'Importando...'
                                    : 'Importar do site'}
                                </button>
                              </div>

                              {siteImportErrorMap[ep.id] && (
                                <div
                                  role="alert"
                                  className="rounded-lg border border-rose-500/35 bg-rose-950/30 px-3 py-2 text-xs text-rose-200 space-y-1.5"
                                >
                                  <p className="text-rose-300">{siteImportErrorMap[ep.id]}</p>
                                  {(siteImportCandidatesMap[ep.id]?.length ?? 0) > 0 && (
                                    <SiteImportCandidateList
                                      candidates={siteImportCandidatesMap[ep.id]}
                                    />
                                  )}
                                </div>
                              )}

                              {siteImportSuccessMap[ep.id] && (
                                <p className="text-xs text-emerald-300">
                                  {siteImportSuccessMap[ep.id]}
                                </p>
                              )}
                            </div>
                          </div>

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

function SiteImportCandidateList({
  candidates,
}: {
  candidates: SiteImportCandidateDiagnostic[];
}) {
  return (
    <ul className="space-y-1.5 font-mono text-[10px] text-slate-300">
      {candidates.map((cand, idx) => (
        <li
          key={`${cand.url}-${idx}`}
          className="space-y-0.5 break-all"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`px-1.5 py-0.5 rounded border ${
                cand.passed
                  ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                  : 'border-rose-500/40 bg-rose-500/15 text-rose-300'
              }`}
            >
              {cand.status !== null ? `HTTP ${cand.status}` : 'erro'}
            </span>
            <span className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-slate-300">
              {cand.type}
            </span>
            {cand.contentType && (
              <span className="text-slate-400">({cand.contentType})</span>
            )}
            <span className="text-slate-300 truncate max-w-full" title={cand.url}>
              {cand.url}
            </span>
          </div>
          {cand.attempts && cand.attempts.length > 0 && (
            <div className="pl-2 text-slate-400">
              Tentativas:{' '}
              {cand.attempts
                .map(
                  (a) =>
                    `${a.referer ?? 'sem Referer'} → ${
                      a.status !== null ? `HTTP ${a.status}` : a.error ?? 'erro'
                    }`
                )
                .join(' · ')}
            </div>
          )}
          {!cand.passed && cand.reason && (
            <div className="pl-2 text-rose-300/90">{cand.reason}</div>
          )}
        </li>
      ))}
    </ul>
  );
}

