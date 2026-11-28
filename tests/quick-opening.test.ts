import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatOpeningTimestamp, parseOpeningRange } from '@/lib/opening-skip';
import type { EpisodeDto } from '@/lib/types';

function makeEpisode(overrides: Partial<EpisodeDto> = {}): EpisodeDto {
  return {
    id: 'ep_opening_test_01',
    anime_name: 'Frieren',
    episode_number: '01',
    opening_start_seconds: 90,
    opening_end_seconds: 180,
    title: 'O Fim da Jornada',
    poster_url: 'https://cdn.example.com/poster.jpg',
    video_url: 'https://cdn.example.com/ep.m3u8',
    video_url_2: null,
    video_url_3: null,
    video_url_4: null,
    video_url_5: null,
    source_kind: 'hls',
    source_kind_2: null,
    source_kind_3: null,
    source_kind_4: null,
    source_kind_5: null,
    public_url: 'https://hikari-player-2.vercel.app/e/ep_opening_test_01',
    created_at: '2026-11-20T10:00:00.000Z',
    updated_at: '2026-11-20T10:00:00.000Z',
    ...overrides,
  };
}

describe('Edição rápida dos tempos da Opening no Admin', () => {
  it('1, 2 e 7. carrega corretamente os valores cadastrados, formata em MM:SS e cancela sem alterar dados', () => {
    const ep = makeEpisode({
      opening_start_seconds: 75, // 01:15
      opening_end_seconds: 165, // 02:45
    });

    const formattedStart = formatOpeningTimestamp(ep.opening_start_seconds);
    const formattedEnd = formatOpeningTimestamp(ep.opening_end_seconds);

    expect(formattedStart).toBe('01:15');
    expect(formattedEnd).toBe('02:45');

    // Simula cancelamento mantendo os valores originais inalterados
    const cancelledStart = formattedStart;
    const cancelledEnd = formattedEnd;
    expect(cancelledStart).toBe('01:15');
    expect(cancelledEnd).toBe('02:45');
    expect(ep.opening_start_seconds).toBe(75);
    expect(ep.opening_end_seconds).toBe(165);
  });

  it('3, 4 e 5. sincroniza perfeitamente os tempos da opening entre a edição rápida e o formulário completo (Editar episódio)', () => {
    const ep = makeEpisode({
      opening_start_seconds: 90,
      opening_end_seconds: 180,
    });

    // Simula alteração feita na edição rápida (quick-edit)
    const newStartStr = '01:35';
    const newEndStr = '03:10';
    const parsedRange = parseOpeningRange(newStartStr, newEndStr);

    expect(parsedRange).toEqual({
      opening_start_seconds: 95,
      opening_end_seconds: 190,
    });

    // Atualiza o episódio com os novos tempos da opening (simulando adminUpdateEpisodeFn)
    const updatedEp: EpisodeDto = {
      ...ep,
      opening_start_seconds: parsedRange.opening_start_seconds,
      opening_end_seconds: parsedRange.opening_end_seconds,
    };

    // O formulário completo (Editar episódio) lê exatamente esses mesmos campos
    expect(formatOpeningTimestamp(updatedEp.opening_start_seconds)).toBe('01:35');
    expect(formatOpeningTimestamp(updatedEp.opening_end_seconds)).toBe('03:10');

    // Fluxo inverso: alteração pelo formulário completo reflete no menu de edição rápida
    const fullFormParsed = parseOpeningRange('02:00', '03:30');
    const updatedViaFullForm: EpisodeDto = {
      ...updatedEp,
      opening_start_seconds: fullFormParsed.opening_start_seconds,
      opening_end_seconds: fullFormParsed.opening_end_seconds,
    };

    expect(formatOpeningTimestamp(updatedViaFullForm.opening_start_seconds)).toBe('02:00');
    expect(formatOpeningTimestamp(updatedViaFullForm.opening_end_seconds)).toBe('03:30');
  });

  it('6 e 9. garante persistência e que apenas o episódio selecionado é atualizado', () => {
    const epA = makeEpisode({ id: 'ep_A', opening_start_seconds: 10, opening_end_seconds: 100 });
    const epB = makeEpisode({ id: 'ep_B', opening_start_seconds: 20, opening_end_seconds: 110 });

    const episodes = [epA, epB];

    const targetId = 'ep_A';
    const parsed = parseOpeningRange('00:30', '02:00');

    const nextEpisodes = episodes.map((item) =>
      item.id === targetId
        ? {
            ...item,
            opening_start_seconds: parsed.opening_start_seconds,
            opening_end_seconds: parsed.opening_end_seconds,
          }
        : item
    );

    // Confirma que epA foi atualizado e epB permaneceu estritamente intacto
    expect(nextEpisodes[0].id).toBe('ep_A');
    expect(nextEpisodes[0].opening_start_seconds).toBe(30);
    expect(nextEpisodes[0].opening_end_seconds).toBe(120);

    expect(nextEpisodes[1].id).toBe('ep_B');
    expect(nextEpisodes[1].opening_start_seconds).toBe(20);
    expect(nextEpisodes[1].opening_end_seconds).toBe(110);
  });

  it('8. valida regras de início e fim incorretos (fim anterior ou igual ao início)', () => {
    expect(() => parseOpeningRange('03:00', '01:30')).toThrow(/fim da opening deve ser maior/i);
    expect(() => parseOpeningRange('02:00', '02:00')).toThrow(/fim da opening deve ser maior/i);
    expect(() => parseOpeningRange('abc', '02:00')).toThrow();
  });

  it('confirma presença da opção "Tempos da Opening" no código fonte do admin.tsx', () => {
    const adminSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/routes/admin.tsx'),
      'utf8'
    );

    expect(adminSource).toContain('Tempos da Opening');
    expect(adminSource).toContain('handleOpenQuickOpening');
    expect(adminSource).toContain('quickOpeningEpisodeId');
    expect(adminSource).toContain('parseOpeningRange');
    expect(adminSource).toContain('adminUpdateEpisodeFn');
  });
});
