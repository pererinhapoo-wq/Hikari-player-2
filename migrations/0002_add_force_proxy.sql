-- Migration: 0002_add_force_proxy.sql
-- Adiciona colunas force_proxy às fontes de vídeo de forma idempotente com padrão true.

ALTER TABLE player_episodes ADD COLUMN IF NOT EXISTS force_proxy boolean DEFAULT true;
ALTER TABLE player_episodes ADD COLUMN IF NOT EXISTS force_proxy_2 boolean DEFAULT true;
ALTER TABLE player_episodes ADD COLUMN IF NOT EXISTS force_proxy_3 boolean DEFAULT true;
ALTER TABLE player_episodes ADD COLUMN IF NOT EXISTS force_proxy_4 boolean DEFAULT true;
ALTER TABLE player_episodes ADD COLUMN IF NOT EXISTS force_proxy_5 boolean DEFAULT true;

ALTER TABLE player_episodes ALTER COLUMN force_proxy SET DEFAULT true;
ALTER TABLE player_episodes ALTER COLUMN force_proxy_2 SET DEFAULT true;
ALTER TABLE player_episodes ALTER COLUMN force_proxy_3 SET DEFAULT true;
ALTER TABLE player_episodes ALTER COLUMN force_proxy_4 SET DEFAULT true;
ALTER TABLE player_episodes ALTER COLUMN force_proxy_5 SET DEFAULT true;
