import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT_DIR = path.resolve(process.cwd());

function readWorkspaceFile(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT_DIR, relativePath), 'utf8');
}

describe('Hikari Player — Cinematic External Interface Animations', () => {
  const indexCss = readWorkspaceFile('src/index.css');
  const rootTsx = readWorkspaceFile('src/routes/__root.tsx');
  const indexTsx = readWorkspaceFile('src/routes/index.tsx');
  const episodeTsx = readWorkspaceFile('src/routes/e/$id.tsx');
  const playerTsx = readWorkspaceFile('src/components/EpisodePlayer.tsx');

  it('defines violet and magenta ambient lighting without heavy CSS filter blurs', () => {
    expect(indexCss).toContain('.hikari-ambient-layer');
    expect(indexCss).toContain('.hikari-ambient-orb-violet');
    expect(indexCss).toContain('.hikari-ambient-orb-magenta');
    expect(indexCss).toContain('rgba(139, 92, 246');
    expect(indexCss).toContain('rgba(217, 70, 239');
    expect(indexCss).not.toMatch(/filter:\s*blur\(/i);
    expect(indexCss).not.toContain('will-change:');
  });

  it('animates ambient, logo, header, page transitions, and divider light using transform and opacity', () => {
    expect(indexCss).toContain('@keyframes hikari-ambient-drift-a');
    expect(indexCss).toContain('@keyframes hikari-ambient-drift-b');
    expect(indexCss).toContain('@keyframes hikari-logo-in');
    expect(indexCss).toContain('@keyframes hikari-header-in');
    expect(indexCss).toContain('@keyframes hikari-page-in');
    expect(indexCss).toContain('@keyframes hikari-divider-sweep');

    expect(indexCss).toContain('translate3d(');
    expect(indexCss).toContain('.hikari-logo-enter');
    expect(indexCss).toContain('.hikari-logo-mark');
    expect(indexCss).toContain('.hikari-header-enter');
    expect(indexCss).toContain('.hikari-page-shell');
    expect(indexCss).toContain('.hikari-page-enter');
    expect(indexCss).toContain('.hikari-page-pending');
    expect(indexCss).toContain('.hikari-divider-glow::before');
  });

  it('respects prefers-reduced-motion and tones down ambient load on mobile viewports', () => {
    expect(indexCss).toContain('@media (max-width: 640px), (pointer: coarse)');
    expect(indexCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(indexCss).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*animation:\s*none\s*!important/);
  });

  it('mounts non-intrusive ambient backdrop and non-blocking router transitions in __root.tsx', () => {
    expect(rootTsx).toContain('useRouterState');
    expect(rootTsx).toContain('PageTransitionShell');
    expect(rootTsx).toContain('className="hikari-ambient-layer" aria-hidden="true"');
    expect(rootTsx).toContain('<div className="relative z-10 min-h-screen">');
    expect(rootTsx).toContain('hikari-page-shell');
    expect(rootTsx).toContain('hikari-page-enter');
    expect(rootTsx).toContain('hikari-page-pending');
    expect(rootTsx).not.toContain('requestAnimationFrame');
  });

  it('applies once-per-session logo animation and existing divider light accent in index.tsx', () => {
    expect(indexTsx).toContain('let hasPlayedLogoEntrance = false');
    expect(indexTsx).toContain('hikari-logo-enter');
    expect(indexTsx).toContain('hikari-logo-mark');
    expect(indexTsx).toContain('hikari-header-enter');
    expect(indexTsx).toContain('hikari-divider-glow');
    expect(indexTsx).toContain('bg-transparent');
    expect(indexTsx).not.toContain('requestAnimationFrame');
  });

  it('exposes ambient backdrop and animates existing header in episode route without altering EpisodePlayer', () => {
    expect(episodeTsx).toContain('hikari-header-enter');
    expect(episodeTsx).toContain('bg-transparent');
    expect(episodeTsx).toContain('<EpisodePlayer');

    // Video stage maintains opaque isolation so ambient lighting never bleeds over video
    expect(playerTsx).toContain('relative w-full aspect-video bg-black border border-white/10 rounded-xl overflow-hidden');
    expect(playerTsx).not.toContain('hikari-ambient');
    expect(playerTsx).not.toContain('hikari-page');
  });
});
