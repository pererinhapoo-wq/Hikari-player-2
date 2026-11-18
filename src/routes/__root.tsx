import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from '@tanstack/react-router';
import appCss from '@/index.css?url';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Player' },
      {
        name: 'description',
        content:
          'Independent anime episode video player by external URL with multi-source fallback and admin management.',
      },
      { property: 'og:title', content: 'Player' },
      {
        property: 'og:description',
        content:
          'Independent anime episode video player by external URL with multi-source fallback and admin management.',
      },
      { property: 'og:type', content: 'website' },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      {
        rel: 'preconnect',
        href: 'https://fonts.gstatic.com',
        crossOrigin: 'anonymous',
      },
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Plus+Jakarta+Sans:wght@500;600;700&display=swap',
      },
    ],
  }),
  component: RootLayout,
  notFoundComponent: RootNotFound,
});

function RootLayout() {
  return (
    <html lang="pt-BR">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-[#090B10] text-slate-100 antialiased selection:bg-rose-600/30 selection:text-white">
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}

function RootNotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-md w-full bg-[#11151E] border border-white/10 rounded-xl p-8 text-center">
        <h1 className="text-xl font-semibold text-white">Página não encontrada</h1>
        <p className="mt-2 text-sm text-slate-400">
          O endereço acessado não existe neste servidor.
        </p>
      </div>
    </main>
  );
}
