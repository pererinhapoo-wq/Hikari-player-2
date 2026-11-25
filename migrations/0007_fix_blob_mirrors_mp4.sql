UPDATE public.player_episodes
SET
  source_kind = CASE
    WHEN video_url ILIKE '%public.blob.vercel-storage.com%' AND video_url ~* '\.(mp4|m4v)(\?|#|$)' THEN 'mp4'
    ELSE source_kind
  END,
  force_proxy = CASE
    WHEN video_url ILIKE '%public.blob.vercel-storage.com%' AND video_url ~* '\.(mp4|m4v)(\?|#|$)' THEN false
    ELSE force_proxy
  END,
  is_mirror = CASE
    WHEN video_url ILIKE '%public.blob.vercel-storage.com%' AND video_url ~* '\.(mp4|m4v)(\?|#|$)' THEN true
    ELSE is_mirror
  END,
  source_kind_2 = CASE
    WHEN video_url_2 ILIKE '%public.blob.vercel-storage.com%' AND video_url_2 ~* '\.(mp4|m4v)(\?|#|$)' THEN 'mp4'
    ELSE source_kind_2
  END,
  force_proxy_2 = CASE
    WHEN video_url_2 ILIKE '%public.blob.vercel-storage.com%' AND video_url_2 ~* '\.(mp4|m4v)(\?|#|$)' THEN false
    ELSE force_proxy_2
  END,
  is_mirror_2 = CASE
    WHEN video_url_2 ILIKE '%public.blob.vercel-storage.com%' AND video_url_2 ~* '\.(mp4|m4v)(\?|#|$)' THEN true
    ELSE is_mirror_2
  END,
  source_kind_3 = CASE
    WHEN video_url_3 ILIKE '%public.blob.vercel-storage.com%' AND video_url_3 ~* '\.(mp4|m4v)(\?|#|$)' THEN 'mp4'
    ELSE source_kind_3
  END,
  force_proxy_3 = CASE
    WHEN video_url_3 ILIKE '%public.blob.vercel-storage.com%' AND video_url_3 ~* '\.(mp4|m4v)(\?|#|$)' THEN false
    ELSE force_proxy_3
  END,
  is_mirror_3 = CASE
    WHEN video_url_3 ILIKE '%public.blob.vercel-storage.com%' AND video_url_3 ~* '\.(mp4|m4v)(\?|#|$)' THEN true
    ELSE is_mirror_3
  END,
  source_kind_4 = CASE
    WHEN video_url_4 ILIKE '%public.blob.vercel-storage.com%' AND video_url_4 ~* '\.(mp4|m4v)(\?|#|$)' THEN 'mp4'
    ELSE source_kind_4
  END,
  force_proxy_4 = CASE
    WHEN video_url_4 ILIKE '%public.blob.vercel-storage.com%' AND video_url_4 ~* '\.(mp4|m4v)(\?|#|$)' THEN false
    ELSE force_proxy_4
  END,
  is_mirror_4 = CASE
    WHEN video_url_4 ILIKE '%public.blob.vercel-storage.com%' AND video_url_4 ~* '\.(mp4|m4v)(\?|#|$)' THEN true
    ELSE is_mirror_4
  END,
  source_kind_5 = CASE
    WHEN video_url_5 ILIKE '%public.blob.vercel-storage.com%' AND video_url_5 ~* '\.(mp4|m4v)(\?|#|$)' THEN 'mp4'
    ELSE source_kind_5
  END,
  force_proxy_5 = CASE
    WHEN video_url_5 ILIKE '%public.blob.vercel-storage.com%' AND video_url_5 ~* '\.(mp4|m4v)(\?|#|$)' THEN false
    ELSE force_proxy_5
  END,
  is_mirror_5 = CASE
    WHEN video_url_5 ILIKE '%public.blob.vercel-storage.com%' AND video_url_5 ~* '\.(mp4|m4v)(\?|#|$)' THEN true
    ELSE is_mirror_5
  END,
  updated_at = NOW()
WHERE
  id = 'PUsNxKDL5TunoQk-GZw74'
  OR video_url ILIKE '%public.blob.vercel-storage.com%'
  OR video_url_2 ILIKE '%public.blob.vercel-storage.com%'
  OR video_url_3 ILIKE '%public.blob.vercel-storage.com%'
  OR video_url_4 ILIKE '%public.blob.vercel-storage.com%'
  OR video_url_5 ILIKE '%public.blob.vercel-storage.com%';
