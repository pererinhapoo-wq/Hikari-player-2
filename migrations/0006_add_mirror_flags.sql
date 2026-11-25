ALTER TABLE public.player_episodes
  ADD COLUMN IF NOT EXISTS is_mirror boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_mirror_2 boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_mirror_3 boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_mirror_4 boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_mirror_5 boolean DEFAULT false;
