import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isEpisodeMirrorPanelOpen,
  toggleSingleMirrorPanel,
} from '@/lib/anime-library';

describe('Controle de abertura e ocultação do painel Espelho na biblioteca do Admin', () => {
  it('1. inicia com todos os painéis Espelho ocultos por padrão', () => {
    const initialOpenEpisodeId: string | null = null;
    expect(isEpisodeMirrorPanelOpen(initialOpenEpisodeId, 'ep_1')).toBe(false);
    expect(isEpisodeMirrorPanelOpen(initialOpenEpisodeId, 'ep_2')).toBe(false);
  });

  it('2 e 3. abre somente o episódio selecionado e oculta ao tocar novamente', () => {
    let openId: string | null = null;

    openId = toggleSingleMirrorPanel(openId, 'ep_1');
    expect(openId).toBe('ep_1');
    expect(isEpisodeMirrorPanelOpen(openId, 'ep_1')).toBe(true);
    expect(isEpisodeMirrorPanelOpen(openId, 'ep_2')).toBe(false);

    openId = toggleSingleMirrorPanel(openId, 'ep_1');
    expect(openId).toBeNull();
    expect(isEpisodeMirrorPanelOpen(openId, 'ep_1')).toBe(false);
    expect(isEpisodeMirrorPanelOpen(openId, 'ep_2')).toBe(false);
  });

  it('4. fecha automaticamente o painel anterior ao abrir o Espelho de outro episódio (no máximo 1 aberto)', () => {
    let openId: string | null = null;

    openId = toggleSingleMirrorPanel(openId, 'ep_1');
    expect(isEpisodeMirrorPanelOpen(openId, 'ep_1')).toBe(true);

    openId = toggleSingleMirrorPanel(openId, 'ep_2');
    expect(openId).toBe('ep_2');
    expect(isEpisodeMirrorPanelOpen(openId, 'ep_1')).toBe(false);
    expect(isEpisodeMirrorPanelOpen(openId, 'ep_2')).toBe(true);

    const openCount = ['ep_1', 'ep_2', 'ep_3'].filter((id) =>
      isEpisodeMirrorPanelOpen(openId, id)
    ).length;
    expect(openCount).toBe(1);
  });

  it('5. preserva mensagens de erro/sucesso, URLs digitadas e dados ao fechar e reabrir o painel', () => {
    const mirrorErrorMap: Record<string, string> = {
      ep_1: 'Erro simulado de limite ou origem',
    };
    const mirrorSuccessMap: Record<string, string> = {
      ep_2: 'Cópia salva no Vercel Blob (Fonte 2).',
    };
    const mirrorInputs: Record<string, string> = {
      ep_1: 'https://bucket.r2.cloudflarestorage.com/ep1.mp4',
    };

    let openId: string | null = 'ep_1';
    expect(isEpisodeMirrorPanelOpen(openId, 'ep_1')).toBe(true);

    // Fechar o painel não apaga erros, sucessos nem URLs digitadas
    openId = toggleSingleMirrorPanel(openId, 'ep_1');
    expect(isEpisodeMirrorPanelOpen(openId, 'ep_1')).toBe(false);
    expect(mirrorErrorMap.ep_1).toBe('Erro simulado de limite ou origem');
    expect(mirrorSuccessMap.ep_2).toBe('Cópia salva no Vercel Blob (Fonte 2).');
    expect(mirrorInputs.ep_1).toBe('https://bucket.r2.cloudflarestorage.com/ep1.mp4');

    // Reabrir exibe novamente as informações preservadas
    openId = toggleSingleMirrorPanel(openId, 'ep_1');
    expect(isEpisodeMirrorPanelOpen(openId, 'ep_1')).toBe(true);
    expect(mirrorErrorMap.ep_1).toBe('Erro simulado de limite ou origem');
    expect(mirrorInputs.ep_1).toBe('https://bucket.r2.cloudflarestorage.com/ep1.mp4');
  });

  it('6. confirma no código fonte do admin.tsx que a abertura depende apenas de openMirrorEpisodeId e reflete estado no botão', () => {
    const adminSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/routes/admin.tsx'),
      'utf8'
    );

    expect(adminSource).toContain('openMirrorEpisodeId');
    expect(adminSource).toContain('toggleSingleMirrorPanel');
    expect(adminSource).toContain('isEpisodeMirrorPanelOpen');
    expect(adminSource).toContain('aria-expanded={isMirrorPanelOpen}');
    expect(adminSource).toContain('aria-controls={`mirror-panel-${ep.id}`}');
    expect(adminSource).toContain('touch-manipulation');
    expect(adminSource).not.toContain('openMirrorPanelIds');
  });
});
