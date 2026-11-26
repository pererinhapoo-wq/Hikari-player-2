import { useEffect, useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Film, Lock } from 'lucide-react';

let hasPlayedLogoEntrance = false;

export const Route = createFileRoute('/')({
  headers: () => ({
    'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900',
    'CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900',
  }),
  component: HomePage,
});

function HomePage() {
  const [animateLogo] = useState(() => !hasPlayedLogoEntrance);

  useEffect(() => {
    hasPlayedLogoEntrance = true;
  }, []);

  return (
    <main className="min-h-screen bg-transparent flex items-center justify-center px-6 py-12">
      <div className="max-w-lg w-full bg-[#11151E]/95 border border-white/10 rounded-xl p-8 sm:p-10">
        <div
          className={`flex items-center gap-3 ${animateLogo ? 'hikari-logo-enter' : ''}`}
        >
          <div className="w-10 h-10 rounded-lg bg-rose-600/15 border border-violet-500/35 flex items-center justify-center text-rose-400 hikari-logo-mark">
            <Film className="w-5 h-5" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">Player</h1>
        </div>

        <p className="mt-4 text-sm sm:text-base text-slate-300 leading-relaxed hikari-header-enter">
          Reprodutor dedicado para episódios por link individual. Abra uma URL no formato{' '}
          <code className="text-xs font-mono text-slate-200 bg-white/5 px-1.5 py-0.5 rounded border border-white/10">
            /e/identificador
          </code>{' '}
          para reproduzir diretamente um episódio cadastrado.
        </p>

        <div className="mt-8 pt-6 border-t border-white/10 hikari-divider-glow flex items-center justify-between gap-4">
          <span className="text-xs text-slate-400">
            Acesso público somente por link direto
          </span>
          <Link
            to="/admin"
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-rose-600 hover:bg-rose-500 text-white transition-colors whitespace-nowrap shrink-0"
          >
            <Lock className="w-4 h-4" />
            Administração
          </Link>
        </div>
      </div>
    </main>
  );
}
