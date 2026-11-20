ALTER TABLE player_episodes ADD COLUMN IF NOT EXISTS anime_name TEXT DEFAULT NULL;
ALTER TABLE player_episodes ADD COLUMN IF NOT EXISTS episode_number TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_player_episodes_anime_name ON player_episodes (anime_name);
