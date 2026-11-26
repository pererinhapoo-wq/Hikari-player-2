import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle, Film } from 'lucide-react';
import { EpisodePlayer } from '@/components/EpisodePlayer';
import { getOptimizedImageProps } from '@/lib/image-optimization';
import { getPublicEpisodeFn } from '@/lib/server-fns';

export const Route = createFileRoute('/e/$id')({
  loader: async ({ params }) => {
    return await getPublicEpisodeFn({ data: { id: params.id } });
  },
  headers: () => ({
    'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400',
    'CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400',
  }),
  head: ({ loaderData }) => {
    const title =
      loaderData?.status === 'ok'
        ? `${loaderData.episode.title} · Player`
        : 'Episódio não encontrado · Player';
    const lcpImage =
      loaderData?.status === 'ok' && loaderData.episode.poster_url
        ? getOptimizedImageProps(loaderData.episode.poster_url, 'banner', { isLcp: true })
        : null;
    return {
      meta: [
        { title },
        { property: 'og:title', content: title },
        ...(lcpImage ? [{ property: 'og:image', content: lcpImage.src }] : []),
      ],
      links: lcpImage
        ? [
            {
              rel: 'preload',
              as: 'image',
              href: lcpImage.src,
              imageSrcSet: lcpImage.srcSet,
              fetchPriority: lcpImage.fetchPriority,
            },
          ]
        : [],
    };
  },
  component: PublicEpisodePage,
});

function PublicEpisodePage() {
  const data = Route.useLoaderData();

  if (data.status === 'db_unconfigured') {
    return (
      <main className="min-h-screen bg-transparent flex items-center justify-center px-6 py-12">
        <div className="max-w-md w-full bg-[#11151E]/95 border border-white/10 rounded-xl p-8 text-center">
          <AlertTriangle className="w-10 h-10 text-amber-400 mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-white">Banco de dados não configurado</h1>
          <p className="mt-2 text-sm text-slate-400">
            Configure a variável <code className="font-mono text-slate-300">DATABASE_URL</code>{' '}
            do Neon e aplique a migration para carregar episódios.
          </p>
        </div>
      </main>
    );
  }

  if (data.status === 'not_found') {
    return (
      <main className="min-h-screen bg-transparent flex items-center justify-center px-6 py-12">
        <div className="max-w-md w-full bg-[#11151E]/95 border border-white/10 rounded-xl p-8 text-center">
          <Film className="w-10 h-10 text-slate-500 mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-white">Episódio não encontrado</h1>
          <p className="mt-2 text-sm text-slate-400">
            O link pode estar incorreto ou este episódio foi removido.
          </p>
        </div>
      </main>
    );
  }

  const { episode } = data;
  const hasSeparateMetaAndTitle = Boolean(
    episode.episode_title && (episode.anime_name || episode.episode_number)
  );

  return (
    <main className="min-h-screen bg-transparent flex flex-col items-center justify-center px-4 sm:px-8 py-6 sm:py-10">
      <div className="w-full max-w-5xl space-y-4">
        <header className="hikari-header-enter flex items-baseline justify-between gap-4">
          <div className="min-w-0 space-y-1">
            {hasSeparateMetaAndTitle && (
              <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm text-slate-400">
                {episode.anime_name && (
                  <span className="font-medium text-slate-300">{episode.anime_name}</span>
                )}
                {episode.episode_number && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-white/[0.06] border border-white/10 text-xs font-mono font-semibold text-slate-200 tabular-nums">
                    Episódio {episode.episode_number}
                  </span>
                )}
              </div>
            )}
            <h1 className="text-lg sm:text-2xl font-semibold tracking-tight text-white text-balance">
              {hasSeparateMetaAndTitle ? episode.episode_title : episode.title}
            </h1>
          </div>
          <span className="text-xs text-slate-500 whitespace-nowrap shrink-0">
            Player
          </span>
        </header>

        <EpisodePlayer
          title={episode.title}
          posterUrl={episode.poster_url}
          sources={episode.sources}
          openingStartSeconds={episode.opening_start_seconds}
          openingEndSeconds={episode.opening_end_seconds}
        />
      </div>
    </main>
  );
}
