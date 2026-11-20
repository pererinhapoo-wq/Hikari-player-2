ALTER TABLE player_episodes ADD COLUMN IF NOT EXISTS opening_start_seconds INTEGER DEFAULT NULL;
ALTER TABLE player_episodes ADD COLUMN IF NOT EXISTS opening_end_seconds INTEGER DEFAULT NULL;
