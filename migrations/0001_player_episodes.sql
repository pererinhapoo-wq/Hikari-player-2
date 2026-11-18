-- Migration: 0001_player_episodes.sql
-- Banco Neon exclusivo do Player (independente de qualquer outro sistema).

CREATE TABLE IF NOT EXISTS player_episodes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  poster_url TEXT NOT NULL,
  video_url TEXT NOT NULL,
  video_url_2 TEXT,
  video_url_3 TEXT,
  video_url_4 TEXT,
  video_url_5 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_player_episodes_created_at
  ON player_episodes (created_at DESC);
