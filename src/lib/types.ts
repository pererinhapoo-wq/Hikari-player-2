import type { ExplicitSourceKind, NormalizedVideoSource } from '@/lib/video-sources';

export interface PlayableSource extends NormalizedVideoSource {
  playUrl: string;
}

export interface EpisodeDto {
  id: string;
  anime_name: string | null;
  episode_number: string | null;
  opening_start_seconds: number | null;
  opening_end_seconds: number | null;
  title: string;
  poster_url: string;
  video_url: string;
  video_url_2: string | null;
  video_url_3: string | null;
  video_url_4: string | null;
  video_url_5: string | null;
  source_kind: ExplicitSourceKind | null;
  source_kind_2: ExplicitSourceKind | null;
  source_kind_3: ExplicitSourceKind | null;
  source_kind_4: ExplicitSourceKind | null;
  source_kind_5: ExplicitSourceKind | null;
  force_proxy?: boolean | null;
  force_proxy_2?: boolean | null;
  force_proxy_3?: boolean | null;
  force_proxy_4?: boolean | null;
  force_proxy_5?: boolean | null;
  is_mirror?: boolean | null;
  is_mirror_2?: boolean | null;
  is_mirror_3?: boolean | null;
  is_mirror_4?: boolean | null;
  is_mirror_5?: boolean | null;
  source_referer?: string | null;
  source_referer_2?: string | null;
  source_referer_3?: string | null;
  source_referer_4?: string | null;
  source_referer_5?: string | null;
  public_url: string;
  created_at: string;
  updated_at: string;
}

export type MirrorEpisodeResult =
  | {
      ok: true;
      episode: EpisodeDto;
      blobUrl: string;
      pathname: string;
      slot: 1 | 2 | 3 | 4 | 5;
    }
  | {
      ok: false;
      error: string;
    };

export interface EpisodeFormPayload {
  anime_name?: string | null;
  episode_number?: string | null;
  opening_start_seconds?: number | null;
  opening_end_seconds?: number | null;
  title: string;
  poster_url: string;
  video_url: string;
  video_url_2?: string | null;
  video_url_3?: string | null;
  video_url_4?: string | null;
  video_url_5?: string | null;
  source_kind?: ExplicitSourceKind | '' | null;
  source_kind_2?: ExplicitSourceKind | '' | null;
  source_kind_3?: ExplicitSourceKind | '' | null;
  source_kind_4?: ExplicitSourceKind | '' | null;
  source_kind_5?: ExplicitSourceKind | '' | null;
  source_referer?: string | null;
  source_referer_2?: string | null;
  source_referer_3?: string | null;
  source_referer_4?: string | null;
  source_referer_5?: string | null;
}

export type PublicEpisodeResult =
  | {
      status: 'ok';
      episode: {
        id: string;
        title: string;
        poster_url: string;
        opening_start_seconds: number | null;
        opening_end_seconds: number | null;
        sources: PlayableSource[];
      };
    }
  | { status: 'not_found' }
  | { status: 'db_unconfigured' };

export interface AdminDashboardState {
  authenticated: boolean;
  databaseConfigured: boolean;
  authConfigured: boolean;
  passwordConfigured: boolean;
  secretConfigured: boolean;
  publicBaseUrl: string;
  episodes: EpisodeDto[];
  errorMessage?: string;
}

export type DatabaseDiagnosisCode =
  | 'ok'
  | 'env_missing'
  | 'env_invalid'
  | 'connection_failed'
  | 'result_interpretation_error'
  | 'table_missing_in_public'
  | 'search_path_mismatch'
  | 'query_failed';

export interface SanitizedDbError {
  name: string;
  code: string | null;
  message: string;
}

export interface DatabaseEnvDiagnostic {
  configured: boolean;
  validUrl: boolean;
  parseError: string | null;
  hostname: string | null;
  database: string | null;
  hasUserInUrl: boolean;
  hasPasswordInUrl: boolean;
  hasPooling: boolean;
  vercelEnv: string | null;
  nodeEnv: string | null;
}

export interface DatabaseQueryDiagnostic {
  current_database: string | null;
  current_schema: string | null;
  current_user: string | null;
  search_path: string | null;
  public_table: string | null;
  resolved_table: string | null;
}

export interface DatabaseDiagnosticResult {
  checkedAt: string;
  diagnosisCode: DatabaseDiagnosisCode;
  diagnosisSummary: string;
  env: DatabaseEnvDiagnostic;
  connectionEstablished: boolean;
  diagnosticQueryExecuted: boolean;
  rawResultShape: string | null;
  connectionError: SanitizedDbError | null;
  connection: DatabaseQueryDiagnostic | null;
  diagnosticQueryError: SanitizedDbError | null;
  tableReadExecuted: boolean;
  episodeCount: number | null;
  tableReadError: SanitizedDbError | null;
  unqualifiedTableReadOk: boolean | null;
  unqualifiedTableReadError: SanitizedDbError | null;
  expectedColumns: string[];
  missingColumns: string[];
  forceProxyColumnsCount: number;
  forceProxyColumnsTotal: number;
  correctionSql: string | null;
}

export type SourceTestVerdict = 'direto_ok' | 'proxy_necessario' | 'bloqueado';

export interface SourceAttemptDiagnostic {
  status: number | null;
  ok: boolean;
  accessControlAllowOrigin: string | null;
  hasAcao: boolean;
  firstLine: string | null;
  contentType: string | null;
  contentLength?: number | null;
  sentReferer: string | null;
  error: string | null;
}

export type EmbedAuthStrategy = 'chrome_ua_with_referer' | 'chrome_ua_no_referer';

export interface EmbedRedirectHopDiagnostic {
  host: string;
  url: string;
  status: number | null;
  location: string | null;
  authMode: EmbedAuthStrategy;
  error: string | null;
}

export interface EmbedHostDiagnostic {
  hostCategory: 'proxied' | 'direct' | 'other';
  hostLabel: string;
  directStatus: number | null;
  hasFrameAncestors: boolean;
  frameAncestorsValue: string | null;
  embedProxyStatus: number | null;
  embedProxyOk: boolean;
  embedProxyError: string | null;
  redirectChain: EmbedRedirectHopDiagnostic[];
  successfulStrategy: EmbedAuthStrategy | null;
  finalUrl: string | null;
}

export interface SourceTestReport {
  slot: 1 | 2 | 3 | 4 | 5;
  label: string;
  url: string;
  detectedKind: ExplicitSourceKind;
  noHeaders: SourceAttemptDiagnostic;
  withHeaders: SourceAttemptDiagnostic;
  verdict: SourceTestVerdict;
  verdictLabel: 'direto ok' | 'proxy necessário' | 'bloqueado';
  verdictReason: string;
  isExpirable?: boolean;
  expirableReason?: string | null;
  embedDiagnostic?: EmbedHostDiagnostic;
}

