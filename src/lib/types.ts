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

export interface DatabaseEnvDiagnostic {
  configured: boolean;
  validUrl: boolean;
  hostname: string | null;
  database: string | null;
  username: string | null;
  hasPooling: boolean;
  vercelEnv: string | null;
}

export interface DatabaseQueryDiagnostic {
  database: string | null;
  schema: string | null;
  user: string | null;
  search_path: string | null;
  public_table: string | null;
  resolved_table: string | null;
  server_address: string | null;
  server_port: number | null;
}

export interface DatabaseDiagnosticResult {
  checkedAt: string;
  env: DatabaseEnvDiagnostic;
  queryOk: boolean;
  connection: DatabaseQueryDiagnostic | null;
  queryError: string | null;
  queryErrorCode: string | null;
}

