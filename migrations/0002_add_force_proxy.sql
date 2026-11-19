-- Migration: 0002_add_force_proxy.sql
-- Adiciona colunas force_proxy às fontes de vídeo de forma idempotente.

ALTER TABLE player_episodes ADD COLUMN IF NOT EXISTS force_proxy boolean DEFAULT NULL;
ALTER TABLE player_episodes ADD COLUMN IF NOT EXISTS force_proxy_2 boolean DEFAULT NULL;
ALTER TABLE player_episodes ADD COLUMN IF NOT EXISTS force_proxy_3 boolean DEFAULT NULL;
ALTER TABLE player_episodes ADD COLUMN IF NOT EXISTS force_proxy_4 boolean DEFAULT NULL;
ALTER TABLE player_episodes ADD COLUMN IF NOT EXISTS force_proxy_5 boolean DEFAULT NULL;
