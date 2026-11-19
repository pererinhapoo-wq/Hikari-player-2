import type { NormalizedVideoSource } from '@/lib/video-sources';

export interface PlayableSource extends NormalizedVideoSource {
  playUrl: string;
}

export interface EpisodeDto {
  id: string;
  title: string;
  poster_url: string;
  video_url: string;
  video_url_2: string | null;
  video_url_3: string | null;
  video_url_4: string | null;
  video_url_5: string | null;
  public_url: string;
  created_at: string;
  updated_at: string;
}

export interface EpisodeFormPayload {
  title: string;
  poster_url: string;
  video_url: string;
  video_url_2?: string | null;
  video_url_3?: string | null;
  video_url_4?: string | null;
  video_url_5?: string | null;
}

export type PublicEpisodeResult =
  | {
      status: 'ok';
      episode: {
        id: string;
        title: string;
        poster_url: string;
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
}


