import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Hikari Player — Ajustes Visuais dos Controles de Reprodução', () => {
  const playerSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/EpisodePlayer.tsx'),
    'utf8'
  );

  it('1. Reduz o botão central de Play na capa inicial com classes responsivas e proporções adequadas', () => {
    // Diâmetro responsivo: w-12 h-12 no mobile, sm:w-14 sm:h-14, md:w-16 md:h-16
    expect(playerSource).toMatch(/className="[^"]*w-12\s+h-12\s+sm:w-14\s+sm:h-14\s+md:w-16\s+md:h-16[^"]*rounded-full[^"]*bg-\[#a855f7\]/);

    // Ícone de Play reduzido proporcionalmente: w-5 h-5 no mobile, sm:w-6 sm:h-6, md:w-7 md:h-7
    expect(playerSource).toMatch(/<Play\s+className="[^"]*w-5\s+h-5\s+sm:w-6\s+sm:h-6\s+md:w-7\s+md:h-7/);

    // Preserva a cor roxa #a855f7 e hover #9333ea
    expect(playerSource).toContain('bg-[#a855f7]');
    expect(playerSource).toContain('hover:bg-[#9333ea]');
  });

  it('2. Garante que o botão central é ocultado durante a reprodução e reaparece quando pausado/terminado', () => {
    // Lógica robusta de verificação do estado real de reprodução
    expect(playerSource).toContain('const isVideoPaused = videoRef.current ? videoRef.current.paused : !isPlaying;');
    expect(playerSource).toContain('const isActuallyPlaying = isPlaying && !isVideoPaused;');
    expect(playerSource).toContain('const showCenterPlay =');
    expect(playerSource).toContain('!isActuallyPlaying');
    expect(playerSource).toContain('isVideoPaused');

    // Botão central quando pausado usa showCenterPlay e dimensões responsivas idênticas
    expect(playerSource).toMatch(/\{showCenterPlay\s*&&\s*\(\s*<button[\s\S]*?className="[^"]*w-12\s+h-12\s+sm:w-14\s+sm:h-14\s+md:w-16\s+md:h-16/);

    // Sincronização de eventos reais do elemento <video>
    expect(playerSource).toContain('onPlaying={() => {');
    expect(playerSource).toContain('onEnded={() => {');
    expect(playerSource).toContain('onWaiting={() => {');

    // Reinício a partir do 0 caso o vídeo tenha terminado
    expect(playerSource).toContain('video.currentTime = 0;');
  });

  it('3. Garante que o botão central nunca fica sobreposto aos controles inferiores', () => {
    // Barra inferior com z-30 para sobrepor com segurança qualquer elemento de fundo
    expect(playerSource).toMatch(/className=\{`[^`]*bottom-2[^`]*z-30[^`]*rounded-xl\s+sm:rounded-2xl/);

    // Botão central posicionado com transform translate para alinhamento geométrico perfeito
    expect(playerSource).toContain('top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2');
  });

  it('4. Reduz as dimensões do botão de velocidade e do texto', () => {
    // Botão compacto: h-7 sm:h-8 px-1.5 sm:px-2 text-[11px] sm:text-xs font-mono
    expect(playerSource).toMatch(/className=\{`px-1\.5\s+sm:px-2\s+h-7\s+sm:h-8\s+rounded-lg\s+text-\[11px\]\s+sm:text-xs\s+font-mono/);
    expect(playerSource).toContain('{playbackRate}x');
  });

  it('5. Menu de velocidade compacto, responsivo e posicionado próximo ao botão sem corte por overflow', () => {
    // Posicionamento imediato acima do botão: bottom-full mb-1.5 right-0
    expect(playerSource).toContain('bottom-full mb-1.5');
    expect(playerSource).toContain('right-0');

    // Dimensões compactas e rolagem interna se o espaço vertical for restrito
    expect(playerSource).toMatch(/min-w-\[62px\]\s+sm:min-w-\[68px\]/);
    expect(playerSource).toMatch(/max-h-\[140px\]\s+sm:max-h-\[160px\]/);
    expect(playerSource).toContain('overflow-y-auto');

    // Espaçamentos internos reduzidos
    expect(playerSource).toMatch(/className="[^"]*p-1[^"]*space-y-0\.5"/);
  });

  it('6. Mantém todas as velocidades exigidas: 0.75x, 1x, 1.25x, 1.5x e 2x com destaque visual e roxo #a855f7', () => {
    expect(playerSource).toMatch(/const SPEED_OPTIONS = \[\s*0\.75,\s*1,\s*1\.25,\s*1\.5,\s*2\s*\] as const;/);

    // Velocidade selecionada recebe destaque com fundo roxo #a855f7 e texto em negrito
    expect(playerSource).toContain("bg-[#a855f7] text-white font-semibold");

    // Fecha o menu ao clicar fora usando atributo [data-speed-control]
    expect(playerSource).toContain('data-speed-control');
    expect(playerSource).toContain("target?.closest('[data-speed-control]')");
  });

  it('7. Preserva todos os controles de reprodução, mute, volume, progresso e tela cheia', () => {
    expect(playerSource).toContain('togglePlayPause');
    expect(playerSource).toContain('toggleMute');
    expect(playerSource).toContain('changeVolume');
    expect(playerSource).toContain('toggleFullscreen');
    expect(playerSource).toContain('handleScrubberPointerDown');
    expect(playerSource).toContain('handleSkipOpening');
  });
});
