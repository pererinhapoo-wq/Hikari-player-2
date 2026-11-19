-- Migration: 0003_add_source_kind.sql
-- Adiciona colunas opcionais source_kind (iframe | hls | mp4) para cada fonte de vídeo.

ALTER TABLE player_episodes ADD COLUMN IF NOT EXISTS source_kind TEXT DEFAULT NULL;
ALTER TABLE player_episodes ADD COLUMN IF NOT EXISTS source_kind_2 TEXT DEFAULT NULL;
ALTER TABLE player_episodes ADD COLUMN IF NOT EXISTS source_kind_3 TEXT DEFAULT NULL;
ALTER TABLE player_episodes ADD COLUMN IF NOT EXISTS source_kind_4 TEXT DEFAULT NULL;
ALTER TABLE player_episodes ADD COLUMN IF NOT EXISTS source_kind_5 TEXT DEFAULT NULL;
