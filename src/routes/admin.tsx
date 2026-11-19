import { createFileRoute, useRouter } from '@tanstack/react-router';
import {
  AlertTriangle,
  Check,
  Copy,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  Film,
  LogOut,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import {
  adminCreateEpisodeFn,
  adminDeleteEpisodeFn,
  adminDiagnoseDatabaseFn,
  adminLoginFn,
  adminLogoutFn,
  adminUpdateEpisodeFn,
  getAdminDashboardFn,
} from '@/lib/server-fns';
import type { DatabaseDiagnosticResult, EpisodeDto, EpisodeFormPayload } from '@/lib/types';
import {
  detectSourceKind,
  type ExplicitSourceKind,
  normalizeVideoSource,
  validateHttpUrl,
} from '@/lib/video-sources';

export const Route = createFileRoute('/admin')({
  loader: async () => {
    return await getAdminDashboardFn();
  },
  head: () => ({
    meta: [{ title: 'Administração · Player' }],
  }),
  component: AdminPage,
});

const EMPTY_FORM: EpisodeFormPayload = {
  title: '',
  poster_url: '',
  video_url: '',
  video_url_2: '',
  video_url_3: '',
  video_url_4: '',
  video_url_5: '',
  source_kind: '',
  source_kind_2: '',
  source_kind_3: '',
  source_kind_4: '',
  source_kind_5: '',
};

const PLAYER_SLOTS: Array<{
  field: 'video_url' | 'video_url_2' | 'video_url_3' | 'video_url_4' | 'video_url_5';
  kindField: 'source_kind' | 'source_kind_2' | 'source_kind_3' | 'source_kind_4' | 'source_kind_5';
  slot: 1 | 2 | 3 | 4 | 5;
  label: string;
  required: boolean;
}> = [
  { field: 'video_url', kindField: 'source_kind', slot: 1, label: 'Player 1', required: true },
  { field: 'video_url_2', kindField: 'source_kind_2', slot: 2, label: 'Player 2', required: false },
  { field: 'video_url_3', kindField: 'source_kind_3', slot: 3, label: 'Player 3', required: false },
  { field: 'video_url_4', kindField: 'source_kind_4', slot: 4, label: 'Player 4', required: false },
  { field: 'video_url_5', kindField: 'source_kind_5', slot: 5, label: 'Player 5', required: false },
];

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

function countEpisodeSources(ep: EpisodeDto): number {
  return [
    ep.video_url,
    ep.video_url_2,
    ep.video_url_3,
    ep.video_url_4,
    ep.video_url_5,
  ].filter((u) => Boolean(u && u.trim())).length;
}

function AdminPage() {
  const router = useRouter();
  const initialState = Route.useLoaderData();

  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<EpisodeFormPayload>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [savedBanner, setSavedBanner] = useState<{
    title: string;
    publicUrl: string;
    action: 'created' | 'updated';
  } | null>(null);

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null);
  const [posterPreviewError, setPosterPreviewError] = useState(false);

  const [diagnostic, setDiagnostic] = useState<DatabaseDiagnosticResult | null>(null);
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);

  const runDiagnostic = async () => {
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
    setEditingId(null);
    setForm(EMPTY_FORM);
    setSavedBanner(null);
    setDiagnostic(null);
    setDiagnosticError(null);
    await router.invalidate();
  };

  const handleEditStart = (ep: EpisodeDto) => {
    setEditingId(ep.id);
    setForm({
      title: ep.title,
      poster_url: ep.poster_url,
      video_url: ep.video_url,
      video_url_2: ep.video_url_2 ?? '',
      video_url_3: ep.video_url_3 ?? '',
      video_url_4: ep.video_url_4 ?? '',
      video_url_5: ep.video_url_5 ?? '',
      source_kind: ep.source_kind ?? '',
      source_kind_2: ep.source_kind_2 ?? '',
      source_kind_3: ep.source_kind_3 ?? '',
      source_kind_4: ep.source_kind_4 ?? '',
      source_kind_5: ep.source_kind_5 ?? '',
    });
    setFormError(null);
    setPosterPreviewError(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setPosterPreviewError(false);
  };

  const handleSaveEpisode = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSaveBusy(true);

    try {
      if (editingId) {
        const res = await adminUpdateEpisodeFn({
          data: { id: editingId, ...form },
        });
        if (!res.ok) {
          setFormError(res.error);
          return;
        }
        setSavedBanner({
          title: res.episode.title,
          publicUrl: res.episode.public_url,
          action: 'updated',
        });
        setEditingId(null);
        setForm(EMPTY_FORM);
      } else {
        const res = await adminCreateEpisodeFn({ data: form });
        if (!res.ok) {
          setFormError(res.error);
          return;
        }
        setSavedBanner({
          title: res.episode.title,
          publicUrl: res.episode.public_url,
          action: 'created',
        });
        setForm(EMPTY_FORM);
      }
      setPosterPreviewError(false);
      await router.invalidate();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Erro ao salvar episódio.');
    } finally {
      setSaveBusy(false);
    }
  };

  const handleConfirmDelete = async (id: string) => {
    setDeleteBusyId(id);
    try {
      const res = await adminDeleteEpisodeFn({ data: { id } });
      if (!res.ok) {
        setFormError(res.error);
      } else {
        if (editingId === id) {
          handleCancelEdit();
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
      {/* Three-zone top bar */}
      <header className="border-b border-white/10 bg-[#0D1018]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
          <span className="text-lg font-semibold tracking-tight text-white whitespace-nowrap shrink-0">
            Player
          </span>

          <nav className="hidden sm:flex items-center gap-6 text-sm text-slate-400">
            <span className="text-slate-200 whitespace-nowrap shrink-0">Administração</span>
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            {initialState.authenticated ? (
              <button
                type="button"
                onClick={handleLogout}
                className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-lg border border-white/10 text-slate-200 hover:bg-white/5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                Sair
              </button>
            ) : (
              <span className="text-xs text-slate-400 whitespace-nowrap shrink-0">
                Área restrita
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        {/* Pending environment setup notice */}
        {missingEnvItems.length > 0 && (
          <section className="bg-[#11151E] border border-amber-500/30 rounded-xl p-5">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div className="space-y-1.5 text-sm">
                <h2 className="font-semibold text-white">
                  Configuração de ambiente pendente
                </h2>
                <p className="text-slate-300">
                  Defina as variáveis de ambiente no servidor e execute{' '}
                  <code className="font-mono text-xs bg-white/5 px-1.5 py-0.5 rounded">
                    migrations/0001_player_episodes.sql
                  </code>{' '}
                  no seu banco Neon antes de usar em produção:{' '}
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
          <section className="max-w-md mx-auto pt-8">
            <form
              onSubmit={handleLogin}
              className="bg-[#11151E] border border-white/10 rounded-xl p-7 space-y-5"
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
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            {/* Left column: Episode Form */}
            <section className="lg:col-span-5 bg-[#11151E] border border-white/10 rounded-xl p-6 space-y-5">
              <div className="flex items-center justify-between gap-4">
                <h1 className="text-lg font-semibold text-white">
                  {editingId ? 'Editar episódio' : 'Novo episódio'}
                </h1>
                {editingId && (
                  <button
                    type="button"
                    onClick={handleCancelEdit}
                    className="text-xs text-slate-400 hover:text-white transition-colors cursor-pointer whitespace-nowrap"
                  >
                    Cancelar edição
                  </button>
                )}
              </div>

              {savedBanner && (
                <div className="p-4 rounded-lg bg-emerald-950/40 border border-emerald-500/30 space-y-2.5">
                  <div className="text-xs font-medium text-emerald-300">
                    {savedBanner.action === 'created'
                      ? `Episódio "${savedBanner.title}" cadastrado.`
                      : `Episódio "${savedBanner.title}" atualizado.`}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={savedBanner.publicUrl}
                      aria-label="Link público gerado"
                      className="flex-1 min-w-0 h-9 px-2.5 rounded bg-[#090B10] border border-white/10 text-xs font-mono text-slate-200"
                    />
                    <button
                      type="button"
                      onClick={() => void copyLink('banner', savedBanner.publicUrl)}
                      className="h-9 px-3 rounded bg-emerald-600 hover:bg-emerald-500 text-xs font-medium text-white inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {copiedId === 'banner' ? (
                        <>
                          <Check className="w-3.5 h-3.5" />
                          Copiado
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          Copiar Link
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}

              <form onSubmit={handleSaveEpisode} className="space-y-4">
                <div>
                  <label
                    htmlFor="ep-title"
                    className="block text-xs font-medium text-slate-300 mb-1.5"
                  >
                    Título do episódio
                  </label>
                  <input
                    id="ep-title"
                    type="text"
                    required
                    maxLength={200}
                    value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                    placeholder="Ex.: Episódio 01 - O Início"
                    className="w-full h-10 px-3 rounded-lg bg-[#090B10] border border-white/15 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500"
                  />
                </div>

                <div>
                  <label
                    htmlFor="ep-poster"
                    className="block text-xs font-medium text-slate-300 mb-1.5"
                  >
                    Imagem de capa (URL)
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
                    className="w-full h-10 px-3 rounded-lg bg-[#090B10] border border-white/15 text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500"
                  />
                  {posterValidation && !posterValidation.valid && (
                    <p className="mt-1 text-xs text-rose-400">{posterValidation.error}</p>
                  )}
                  {posterValidation?.valid && !posterPreviewError && (
                    <div className="mt-2.5 aspect-video w-full rounded-lg overflow-hidden border border-white/10 bg-[#090B10]">
                      <img
                        src={posterValidation.normalizedUrl}
                        alt="Prévia da capa"
                        referrerPolicy="no-referrer"
                        onError={() => setPosterPreviewError(true)}
                        className="w-full h-full object-cover"
                      />
                    </div>
                  )}
                </div>

                <div className="pt-2 border-t border-white/10 space-y-3.5">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-medium text-slate-200">
                      Fontes de vídeo (até 5 URLs)
                    </span>
                    <span className="text-[11px] text-slate-400">
                      Aceita URL direta de mídia (.m3u8, .mp4, .webm) ou página de player do provedor (playerricas.php, .php, embed). Se kind ficar vazio, a detecção é automática.
                    </span>
                  </div>

                  {PLAYER_SLOTS.map(({ field, kindField, slot, label, required }) => {
                    const value = (form[field] ?? '') as string;
                    const selectedKind = (form[kindField] ?? '') as ExplicitSourceKind | '';
                    const trimmed = value.trim();
                    const check = trimmed ? validateHttpUrl(trimmed) : null;
                    const normalized = trimmed
                      ? normalizeVideoSource(trimmed, slot, selectedKind || null)
                      : null;
                    const detectedKind = trimmed
                      ? detectSourceKind(trimmed, selectedKind || null)
                      : null;

                    return (
                      <div key={field}>
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <label
                            htmlFor={`ep-${field}`}
                            className="text-xs font-medium text-slate-300"
                          >
                            {label} {required ? '' : '(opcional)'}
                          </label>
                          <div className="flex items-center gap-2">
                            {detectedKind ? (
                              <span className="text-[11px] font-mono text-emerald-300">
                                kind: {detectedKind}
                              </span>
                            ) : null}
                            {normalized ? (
                              <span className="text-[11px] font-mono text-slate-400">
                                {normalized.formatLabel}
                              </span>
                            ) : check && !check.valid ? (
                              <span className="text-[11px] text-rose-400">
                                URL inválida
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            id={`ep-${field}`}
                            type="url"
                            required={required}
                            value={value}
                            onChange={(e) =>
                              setForm({ ...form, [field]: e.target.value })
                            }
                            placeholder={
                              slot === 1
                                ? 'https://.../playerricas.php?... ou https://.../index.m3u8'
                                : `URL alternativa (${label}: página .php, .m3u8 ou .mp4)`
                            }
                            className="flex-1 min-w-0 h-10 px-3 rounded-lg bg-[#090B10] border border-white/15 text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500"
                          />
                          <select
                            id={`ep-${kindField}`}
                            aria-label={`Kind de ${label}`}
                            value={selectedKind}
                            onChange={(e) =>
                              setForm({
                                ...form,
                                [kindField]: e.target.value as ExplicitSourceKind | '',
                              })
                            }
                            className="h-10 px-2.5 rounded-lg bg-[#090B10] border border-white/15 text-xs font-mono text-slate-200 focus:outline-none focus:border-rose-500 shrink-0"
                          >
                            <option value="">auto</option>
                            <option value="iframe">iframe</option>
                            <option value="hls">hls</option>
                            <option value="mp4">mp4</option>
                          </select>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {formError && (
                  <p className="text-sm text-rose-400" role="alert">
                    {formError}
                  </p>
                )}

                <div className="pt-2 flex items-center gap-3">
                  <button
                    type="submit"
                    disabled={saveBusy || !initialState.databaseConfigured}
                    className="flex-1 h-11 px-4 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-sm font-medium text-white inline-flex items-center justify-center gap-2 transition-colors cursor-pointer"
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

            {/* Right column: Registered Episodes List */}
            <section className="lg:col-span-7 bg-[#11151E] border border-white/10 rounded-xl overflow-hidden">
              <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold text-white">
                    Episódios cadastrados
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5 tabular-nums">
                    {initialState.episodes.length}{' '}
                    {initialState.episodes.length === 1 ? 'episódio' : 'episódios'} ·
                    Base pública{' '}
                    <span className="font-mono text-slate-300">
                      {initialState.publicBaseUrl}
                    </span>
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => void runDiagnostic()}
                  disabled={diagnosticBusy}
                  className="h-8 px-3 rounded-lg border border-white/10 text-xs font-medium text-slate-200 hover:bg-white/5 disabled:opacity-50 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Database className="w-3.5 h-3.5" />
                  {diagnosticBusy ? 'Diagnosticando...' : 'Diagnóstico Neon'}
                </button>
              </div>

              {initialState.errorMessage && (
                <div className="px-6 py-4 border-b border-white/10 bg-rose-950/30 text-sm text-rose-300">
                  {initialState.errorMessage}
                </div>
              )}

              {(diagnostic || diagnosticError || diagnosticBusy) && (
                <div className="px-6 py-4 border-b border-white/10 bg-[#0D1018] space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                      Diagnóstico da conexão Neon (somente leitura)
                    </h3>
                    {diagnostic && (
                      <span className="text-[11px] font-mono text-slate-400">
                        {diagnostic.env.vercelEnv ?? 'local'} · {diagnostic.diagnosisCode}
                      </span>
                    )}
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

                      {/* Etapa 1: Variável DATABASE_URL */}
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
                          <dt className="text-slate-400">Credenciais (URL):</dt>
                          <dd className="text-slate-200">
                            {diagnostic.env.hasUserInUrl ? 'Usuário OK' : 'Sem usuário'} ·{' '}
                            {diagnostic.env.hasPasswordInUrl ? 'Senha OK' : 'Sem senha'}
                          </dd>
                        </div>
                        {diagnostic.env.parseError && (
                          <div className="sm:col-span-2 text-rose-300 pt-1 border-t border-white/10">
                            Erro na URL: {diagnostic.env.parseError}
                          </div>
                        )}
                      </dl>

                      {/* Etapas 2 e 3: Conexão e consulta de contexto SQL */}
                      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 bg-[#090B10] border border-white/10 rounded-lg p-3 font-mono">
                        <div className="flex justify-between gap-2">
                          <dt className="text-slate-400">Conexão Neon:</dt>
                          <dd
                            className={
                              diagnostic.connectionEstablished
                                ? 'text-emerald-400'
                                : 'text-rose-400'
                            }
                          >
                            {diagnostic.connectionEstablished ? 'Estabelecida' : 'Falhou'}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-slate-400">Consulta diagnóstico:</dt>
                          <dd
                            className={
                              diagnostic.diagnosticQueryExecuted
                                ? 'text-emerald-400'
                                : 'text-rose-400'
                            }
                          >
                            {diagnostic.diagnosticQueryExecuted ? 'Executada' : 'Não executada'}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-slate-400">current_database:</dt>
                          <dd className="text-slate-200">
                            {diagnostic.connection?.current_database ??
                              (diagnostic.connectionEstablished ? 'null' : 'Sem conexão')}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-slate-400">current_schema:</dt>
                          <dd className="text-slate-200">
                            {diagnostic.connection?.current_schema ??
                              (diagnostic.connectionEstablished ? 'null' : 'Sem conexão')}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-slate-400">current_user:</dt>
                          <dd className="text-slate-200">
                            {diagnostic.connection?.current_user ??
                              (diagnostic.connectionEstablished ? 'null' : 'Sem conexão')}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-slate-400">search_path:</dt>
                          <dd className="text-slate-200">
                            {diagnostic.connection?.search_path ??
                              (diagnostic.connectionEstablished ? 'null' : 'Sem conexão')}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-slate-400">to_regclass(public):</dt>
                          <dd
                            className={
                              diagnostic.connection?.public_table
                                ? 'text-emerald-400'
                                : 'text-rose-400'
                            }
                          >
                            {diagnostic.connection
                              ? diagnostic.connection.public_table ?? 'null (ausente)'
                              : 'Não verificado'}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-slate-400">to_regclass(sem schema):</dt>
                          <dd
                            className={
                              diagnostic.connection?.resolved_table
                                ? 'text-emerald-400'
                                : 'text-rose-400'
                            }
                          >
                            {diagnostic.connection
                              ? diagnostic.connection.resolved_table ?? 'null (não resolvida)'
                              : 'Não verificado'}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2 sm:col-span-2">
                          <dt className="text-slate-400">SELECT COUNT(*) public:</dt>
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
                                : 'Não executado (sem conexão)'}
                          </dd>
                        </div>
                        {diagnostic.rawResultShape && (
                          <div className="flex justify-between gap-2 sm:col-span-2 text-slate-400">
                            <dt>Retorno driver Neon:</dt>
                            <dd className="text-slate-300 truncate">{diagnostic.rawResultShape}</dd>
                          </div>
                        )}
                        <div className="flex justify-between gap-2 sm:col-span-2">
                          <dt className="text-slate-400">Colunas force_proxy:</dt>
                          <dd
                            className={
                              diagnostic.forceProxyColumnsCount === 5
                                ? 'text-emerald-400'
                                : 'text-amber-400 font-semibold'
                            }
                          >
                            {diagnostic.forceProxyColumnsCount}/5 {diagnostic.forceProxyColumnsCount === 5 ? 'presentes' : 'presentes (atenção)'}
                          </dd>
                        </div>
                      </dl>

                      {diagnostic.missingColumns && diagnostic.missingColumns.length > 0 && (
                        <div className="bg-amber-950/40 border border-amber-500/40 rounded-lg p-3 space-y-2">
                          <div className="text-xs font-semibold text-amber-200">
                            Colunas ausentes na tabela player_episodes: {diagnostic.missingColumns.join(', ')}
                          </div>
                          <p className="text-[11px] text-slate-300">
                            Copie e execute o comando SQL abaixo no seu painel Neon para corrigir o schema:
                          </p>
                          <div className="flex items-center gap-2">
                            <textarea
                              readOnly
                              rows={3}
                              value={diagnostic.correctionSql ?? ''}
                              className="flex-1 w-full p-2 rounded bg-[#090B10] border border-white/10 font-mono text-[11px] text-amber-200 select-all"
                            />
                            <button
                              type="button"
                              onClick={() => void copyLink('sql-fix', diagnostic.correctionSql ?? '')}
                              className="h-8 px-3 rounded bg-amber-600 hover:bg-amber-500 text-xs font-medium text-white inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                            >
                              {copiedId === 'sql-fix' ? (
                                <>
                                  <Check className="w-3.5 h-3.5" />
                                  Copiado
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3.5 h-3.5" />
                                  Copiar SQL
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                      )}

                      {(diagnostic.connectionError ||
                        diagnostic.diagnosticQueryError ||
                        diagnostic.tableReadError ||
                        diagnostic.unqualifiedTableReadError) && (
                        <div className="bg-rose-950/30 border border-rose-500/30 rounded-lg p-3 font-mono text-rose-300 space-y-1.5">
                          {diagnostic.connectionError && (
                            <div>
                              Falha na conexão ({diagnostic.connectionError.name}
                              {diagnostic.connectionError.code
                                ? ` [${diagnostic.connectionError.code}]`
                                : ''}
                              ): {diagnostic.connectionError.message}
                            </div>
                          )}
                          {diagnostic.diagnosticQueryError && (
                            <div>
                              Falha na consulta de diagnóstico ({diagnostic.diagnosticQueryError.name}
                              {diagnostic.diagnosticQueryError.code
                                ? ` [${diagnostic.diagnosticQueryError.code}]`
                                : ''}
                              ): {diagnostic.diagnosticQueryError.message}
                            </div>
                          )}
                          {diagnostic.tableReadError && (
                            <div>
                              Falha em SELECT COUNT(*) public.player_episodes (
                              {diagnostic.tableReadError.name}
                              {diagnostic.tableReadError.code
                                ? ` [${diagnostic.tableReadError.code}]`
                                : ''}
                              ): {diagnostic.tableReadError.message}
                            </div>
                          )}
                          {diagnostic.unqualifiedTableReadError && (
                            <div>
                              Falha em SELECT COUNT(*) player_episodes (
                              {diagnostic.unqualifiedTableReadError.name}
                              {diagnostic.unqualifiedTableReadError.code
                                ? ` [${diagnostic.unqualifiedTableReadError.code}]`
                                : ''}
                              ): {diagnostic.unqualifiedTableReadError.message}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {initialState.episodes.length === 0 ? (
                <div className="px-6 py-14 text-center">
                  <Film className="w-9 h-9 text-slate-600 mx-auto mb-3" />
                  <p className="text-sm font-medium text-slate-200">
                    Nenhum episódio cadastrado ainda
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    Preencha o formulário ao lado para gerar o primeiro link de reprodução.
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-white/10">
                  {initialState.episodes.map((ep) => {
                    const sourceCount = countEpisodeSources(ep);
                    const isDeleting = confirmDeleteId === ep.id;
                    const isBusyDeleting = deleteBusyId === ep.id;

                    return (
                      <li
                        key={ep.id}
                        className="px-6 py-4 hover:bg-white/[0.02] transition-colors space-y-3"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0">
                            <h3 className="text-sm font-semibold text-white truncate">
                              {ep.title}
                            </h3>
                            <p className="mt-1 text-xs text-slate-400 tabular-nums">
                              {sourceCount}{' '}
                              {sourceCount === 1 ? 'fonte' : 'fontes'}
                              <span aria-hidden="true"> · </span>
                              {formatDatePtBr(ep.created_at)}
                            </p>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => handleEditStart(ep)}
                              aria-label={`Editar ${ep.title}`}
                              className="h-8 px-2.5 rounded-lg border border-white/10 text-xs text-slate-200 hover:bg-white/5 inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                              Editar
                            </button>

                            {isDeleting ? (
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  disabled={isBusyDeleting}
                                  onClick={() => void handleConfirmDelete(ep.id)}
                                  className="h-8 px-2.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-xs font-medium text-white cursor-pointer whitespace-nowrap"
                                >
                                  {isBusyDeleting ? 'Excluindo...' : 'Confirmar'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteId(null)}
                                  className="h-8 px-2 rounded-lg border border-white/10 text-xs text-slate-300 hover:bg-white/5 cursor-pointer"
                                >
                                  Cancelar
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(ep.id)}
                                aria-label={`Excluir ${ep.title}`}
                                className="h-8 px-2.5 rounded-lg border border-white/10 text-xs text-rose-300 hover:bg-rose-500/10 inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                Excluir
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Public episode link row */}
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            readOnly
                            value={ep.public_url}
                            aria-label={`Link público de ${ep.title}`}
                            className="flex-1 min-w-0 h-9 px-2.5 rounded-lg bg-[#090B10] border border-white/10 text-xs font-mono text-slate-300"
                          />
                          <button
                            type="button"
                            onClick={() => void copyLink(ep.id, ep.public_url)}
                            className="h-9 px-3 rounded-lg border border-white/10 text-xs font-medium text-slate-200 hover:bg-white/5 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            {copiedId === ep.id ? (
                              <>
                                <Check className="w-3.5 h-3.5 text-emerald-400" />
                                Copiado
                              </>
                            ) : (
                              <>
                                <Copy className="w-3.5 h-3.5" />
                                Copiar Link
                              </>
                            )}
                          </button>
                          <a
                            href={`/e/${encodeURIComponent(ep.id)}`}
                            target="_blank"
                            rel="noreferrer"
                            className="h-9 px-3 rounded-lg border border-white/10 text-xs font-medium text-slate-200 hover:bg-white/5 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                            Abrir
                          </a>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
