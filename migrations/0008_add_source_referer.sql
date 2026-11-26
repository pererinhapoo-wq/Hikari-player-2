ALTER TABLE player_episodes
  ADD COLUMN IF NOT EXISTS source_referer TEXT,
  ADD COLUMN IF NOT EXISTS source_referer_2 TEXT,
  ADD COLUMN IF NOT EXISTS source_referer_3 TEXT,
  ADD COLUMN IF NOT EXISTS source_referer_4 TEXT,
  ADD COLUMN IF NOT EXISTS source_referer_5 TEXT;
