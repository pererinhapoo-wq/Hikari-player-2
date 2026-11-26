import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  countEpisodeSources,
  filterAndSortAnimeGroups,
  formatEpisodeDisplayTitle,
  groupEpisodesByAnime,
  sortAnimeEpisodes,
  UNASSIGNED_ANIME_KEY,
  UNASSIGNED_ANIME_LABEL,
} from '@/lib/anime-library';
import {
  createEpisode,
  type DiagnosticSqlTag,
  sanitizeEpisodeInput,
  updateEpisode,
} from '@/lib/db';
import type { EpisodeDto } from '@/lib/types';

function makeEpisode(overrides: Partial<EpisodeDto> = {}): EpisodeDto {
  return {
    id: 'ep_default_01',
    anime_name: null,
    episode_number: null,
    opening_start_seconds: null,
    opening_end_seconds: null,
    title: 'Episódio sem título',
    poster_url: 'https://cdn.example.com/poster.jpg',
    video_url: 'https://cdn.example.com/ep.m3u8',
    video_url_2: null,
    video_url_3: null,
    video_url_4: null,
    video_url_5: null,
    source_kind: null,
    source_kind_2: null,
    source_kind_3: null,
    source_kind_4: null,
    source_kind_5: null,
    public_url: 'https://hikari-player-2.vercel.app/e/ep_default_01',
    created_at: '2026-11-10T12:00:00.000Z',
    updated_at: '2026-11-10T12:00:00.000Z',
    ...overrides,
  };
}

describe('Biblioteca administrativa agrupada por anime', () => {
  it('1. agrupa episódios por nome do anime (ignorando caixa/espaços extras) e coloca registros antigos em "Sem anime associado"', () => {
    const episodes: EpisodeDto[] = [
      makeEpisode({
        id: 'id_1',
        anime_name: 'Frieren',
        episode_number: '2',
        title: 'Não Precisa Ser Mágica',
        poster_url: 'https://cdn.example.com/frieren-2.jpg',
        created_at: '2026-11-15T12:00:00.000Z',
      }),
      makeEpisode({
        id: 'id_2',
        anime_name: '  frieren  ',
        episode_number: '1',
        title: 'O Fim da Jornada',
        poster_url: 'https://cdn.example.com/frieren-1.jpg',
        created_at: '2026-11-12T12:00:00.000Z',
      }),
      makeEpisode({
        id: 'id_3',
        anime_name: 'Solo Leveling',
        episode_number: '10',
        title: '',
        poster_url: 'https://cdn.example.com/solo-10.jpg',
        created_at: '2026-11-18T12:00:00.000Z',
      }),
      makeEpisode({
        id: 'id_4',
        anime_name: null,
        episode_number: null,
        title: 'Registro antigo sem anime',
        poster_url: 'https://cdn.example.com/old.jpg',
        created_at: '2026-11-01T12:00:00.000Z',
      }),
    ];

    const groups = groupEpisodesByAnime(episodes);
    expect(groups).toHaveLength(3);

    const frieren = groups.find((g) => g.key === 'frieren');
    expect(frieren).toBeDefined();
    expect(frieren?.episodeCount).toBe(2);
    expect(frieren?.representativePosterUrl).toBe('https://cdn.example.com/frieren-2.jpg');
    expect(frieren?.episodes.map((e) => e.episode_number)).toEqual(['1', '2']);

    const solo = groups.find((g) => g.key === 'solo leveling');
    expect(solo?.episodeCount).toBe(1);

    const unassigned = groups.find((g) => g.key === UNASSIGNED_ANIME_KEY);
    expect(unassigned).toBeDefined();
    expect(unassigned?.name).toBe(UNASSIGNED_ANIME_LABEL);
    expect(unassigned?.isUnassigned).toBe(true);
    expect(unassigned?.episodeCount).toBe(1);
    expect(unassigned?.episodes[0].id).toBe('id_4');
  });

  it('2. filtra animes na pesquisa (sem diferenciar acentos/maiúsculas) e ordena por nome ou cadastro mais recente', () => {
    const episodes: EpisodeDto[] = [
      makeEpisode({
        id: 'a1',
        anime_name: 'Attack on Titan',
        created_at: '2026-11-01T10:00:00.000Z',
      }),
      makeEpisode({
        id: 'b1',
        anime_name: 'Bocchi the Rock!',
        created_at: '2026-11-18T10:00:00.000Z',
      }),
      makeEpisode({
        id: 'c1',
        anime_name: 'Kaguya-sama: É Amor',
        created_at: '2026-11-10T10:00:00.000Z',
      }),
      makeEpisode({
        id: 'u1',
        anime_name: null,
        title: 'Antigo',
        created_at: '2026-11-19T10:00:00.000Z',
      }),
    ];

    const groups = groupEpisodesByAnime(episodes);

    const byRecent = filterAndSortAnimeGroups(groups, '', 'recent');
    expect(byRecent.map((g) => g.name)).toEqual([
      'Bocchi the Rock!',
      'Kaguya-sama: É Amor',
      'Attack on Titan',
      UNASSIGNED_ANIME_LABEL,
    ]);

    const byName = filterAndSortAnimeGroups(groups, '', 'name');
    expect(byName.map((g) => g.name)).toEqual([
      'Attack on Titan',
      'Bocchi the Rock!',
      'Kaguya-sama: É Amor',
      UNASSIGNED_ANIME_LABEL,
    ]);

    const searched = filterAndSortAnimeGroups(groups, 'e amor', 'name');
    expect(searched.map((g) => g.name)).toEqual(['Kaguya-sama: É Amor']);
  });

  it('3. ordena episódios numericamente dentro do anime (1, 2, 10, 12.5) e conta fontes preservadas', () => {
    const sorted = sortAnimeEpisodes([
      makeEpisode({ id: 'e10', episode_number: '10' }),
      makeEpisode({ id: 'e2', episode_number: '2' }),
      makeEpisode({ id: 'e12_5', episode_number: '12.5' }),
      makeEpisode({ id: 'e1', episode_number: '01' }),
      makeEpisode({ id: 'e_none', episode_number: null, created_at: '2026-11-18T00:00:00.000Z' }),
    ]);

    expect(sorted.map((e) => e.id)).toEqual(['e1', 'e2', 'e10', 'e12_5', 'e_none']);

    const legacyMultiSource = makeEpisode({
      video_url: 'https://cdn.example.com/1.m3u8',
      video_url_2: 'https://cdn.example.com/2.mp4',
      video_url_3: 'https://cdn.example.com/3.php',
    });
    expect(countEpisodeSources(legacyMultiSource)).toBe(3);
  });

  it('4. formata título público preservando títulos existentes e gerando fallback apenas quando título está vazio', () => {
    expect(
      formatEpisodeDisplayTitle({
        anime_name: 'Bleach',
        episode_number: '05',
        title: 'Título Original',
      })
    ).toBe('Título Original');

    expect(
      formatEpisodeDisplayTitle({
        anime_name: 'Bleach',
        episode_number: '05',
        title: '',
      })
    ).toBe('Bleach · Episódio 05');

    expect(
      formatEpisodeDisplayTitle({
        anime_name: 'Bleach',
        episode_number: null,
        title: '',
      })
    ).toBe('Bleach');
  });
});

describe('Persistência, Player único e preservação de registros antigos', () => {
  it('5. valida entrada permitindo título opcional quando anime_name está preenchido e rejeita quando ambos estão vazios', () => {
    const valid = sanitizeEpisodeInput({
      anime_name: '  Dandadan  ',
      episode_number: ' 01 ',
      title: '',
      poster_url: 'https://cdn.example.com/poster.jpg',
      video_url: 'https://cdn.example.com/ep1.m3u8',
      source_kind: 'hls',
    });

    expect(valid.anime_name).toBe('Dandadan');
    expect(valid.episode_number).toBe('01');
    expect(valid.title).toBe('');
    expect(valid.video_url_2).toBeUndefined();

    expect(() =>
      sanitizeEpisodeInput({
        anime_name: '',
        episode_number: '01',
        title: '',
        poster_url: 'https://cdn.example.com/poster.jpg',
        video_url: 'https://cdn.example.com/ep1.m3u8',
      })
    ).toThrow(/nome do anime ou o título/i);
  });

  it('6. cadastra novo episódio com anime_name e episode_number preservando formato do ID público', async () => {
    let capturedValues: unknown[] = [];
    const mockSql: DiagnosticSqlTag = async (_strings, ...values) => {
      capturedValues = values;
      return [
        {
          id: String(values[0]),
          anime_name: values[1],
          episode_number: values[2],
          title: values[3],
          poster_url: values[4],
          video_url: values[5],
          video_url_2: null,
          video_url_3: null,
          video_url_4: null,
          video_url_5: null,
          source_kind: values[10],
          source_kind_2: null,
          source_kind_3: null,
          source_kind_4: null,
          source_kind_5: null,
          force_proxy: true,
          force_proxy_2: true,
          force_proxy_3: true,
          force_proxy_4: true,
          force_proxy_5: true,
          created_at: '2026-11-19T12:00:00.000Z',
          updated_at: '2026-11-19T12:00:00.000Z',
        },
      ];
    };

    const created = await createEpisode(
      {
        anime_name: 'Frieren',
        episode_number: '03',
        title: 'Mágica para Matar',
        poster_url: 'https://cdn.example.com/f3.jpg',
        video_url: 'https://cdn.example.com/f3.m3u8',
        source_kind: 'hls',
      },
      mockSql
    );

    expect(created.id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    expect(created.anime_name).toBe('Frieren');
    expect(created.episode_number).toBe('03');
    expect(capturedValues[1]).toBe('Frieren');
    expect(capturedValues[2]).toBe('03');
  });

  it('7. ao editar episódio em modo Player único (sem campos 2..5), não sobrescreve fontes adicionais antigas no banco', async () => {
    let executedQuery = '';
    const mockSql: DiagnosticSqlTag = async (strings) => {
      executedQuery = strings.join(' ');
      return [
        {
          id: 'legacy_ep_1',
          anime_name: 'Bakemonogatari',
          episode_number: '01',
          title: 'Hitagi Crab - Parte 1',
          poster_url: 'https://cdn.example.com/bake-01.jpg',
          video_url: 'https://cdn.example.com/new-p1.m3u8',
          video_url_2: 'https://cdn.example.com/old-p2.mp4',
          video_url_3: 'https://cdn.example.com/old-p3.php',
          video_url_4: null,
          video_url_5: null,
          source_kind: 'hls',
          source_kind_2: 'mp4',
          source_kind_3: 'iframe',
          source_kind_4: null,
          source_kind_5: null,
          force_proxy: true,
          force_proxy_2: true,
          force_proxy_3: true,
          force_proxy_4: true,
          force_proxy_5: true,
          created_at: '2025-10-01T12:00:00.000Z',
          updated_at: '2026-11-19T12:00:00.000Z',
        },
      ];
    };

    const updated = await updateEpisode(
      'legacy_ep_1',
      {
        anime_name: 'Bakemonogatari',
        episode_number: '01',
        title: 'Hitagi Crab - Parte 1',
        poster_url: 'https://cdn.example.com/bake-01.jpg',
        video_url: 'https://cdn.example.com/new-p1.m3u8',
        source_kind: 'hls',
      },
      mockSql
    );

    expect(executedQuery).not.toContain('video_url_2 =');
    expect(executedQuery).not.toContain('source_kind_2 =');
    expect(executedQuery).not.toContain('force_proxy_2 =');
    expect(updated?.anime_name).toBe('Bakemonogatari');
    expect(updated?.episode_number).toBe('01');
    expect(updated?.video_url_2).toBe('https://cdn.example.com/old-p2.mp4');
    expect(updated?.video_url_3).toBe('https://cdn.example.com/old-p3.php');
  });

  it('8. confirma que o formulário administrativo expõe apenas Player 1 e não exibe Player 2–5', () => {
    const adminSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/routes/admin.tsx'),
      'utf8'
    );

    expect(adminSource).toContain('Player 1');
    expect(adminSource).not.toContain('Player 2');
    expect(adminSource).not.toContain('Player 3');
    expect(adminSource).not.toContain('Player 4');
    expect(adminSource).not.toContain('Player 5');
    expect(adminSource).toContain('Biblioteca de episódios');
    expect(adminSource).toContain('Voltar para animes');
  });

  it('9. remove avisos grandes R2 dos cards da listagem mantendo badges compactos e aviso no formulário, sem importação de site', () => {
    const adminSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/routes/admin.tsx'),
      'utf8'
    );
    const serverFnsSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/server-fns.ts'),
      'utf8'
    );

    // 1. Cards sem aviso grande de R2
    expect(adminSource).not.toContain('r2EpisodeInspection');
    // 2. Indicadores compactos R2 e expirável preservados nos cards + aviso completo mantido no formulário
    expect(adminSource).toContain('src.r2Inspection.badgeLabel');
    expect(adminSource).toContain('expirável');
    expect(adminSource).toContain('primarySourceInfo?.r2Inspection.warningMessage');
    // 3 e 4. Ausência da seção, botão e servidor de Importar do site
    expect(adminSource).not.toContain('Importar do site');
    expect(adminSource).not.toContain('URL da página do episódio');
    expect(adminSource).not.toContain('adminImportFromSiteFn');
    expect(serverFnsSource).not.toContain('adminImportFromSiteFn');
    expect(serverFnsSource).not.toContain('processSiteImportServer');
    expect(serverFnsSource).not.toContain('site-import');
  });
});

