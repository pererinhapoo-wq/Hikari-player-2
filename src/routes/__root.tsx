import { useEffect, useRef, useState } from 'react';
import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
  useRouterState,
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

function PageTransitionShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const routerStatus = useRouterState({ select: (s) => s.status });
  const initialPathnameRef = useRef(pathname);
  const [hasNavigated, setHasNavigated] = useState(false);

  useEffect(() => {
    if (pathname !== initialPathnameRef.current) {
      setHasNavigated(true);
    }
  }, [pathname]);

  const shouldAnimateEnter = hasNavigated || pathname !== initialPathnameRef.current;
  const isPendingNavigation = routerStatus === 'pending';

  return (
    <div
      key={pathname}
      className={[
        'hikari-page-shell',
        shouldAnimateEnter ? 'hikari-page-enter' : '',
        isPendingNavigation ? 'hikari-page-pending' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Outlet />
    </div>
  );
}

function RootLayout() {
  return (
    <html lang="pt-BR">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-[#090B10] text-slate-100 antialiased selection:bg-rose-600/30 selection:text-white">
        <div className="hikari-ambient-layer" aria-hidden="true">
          <div className="hikari-ambient-orb-violet" />
          <div className="hikari-ambient-orb-magenta" />
        </div>
        <div className="relative z-10 min-h-screen">
          <PageTransitionShell />
        </div>
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
