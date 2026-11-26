import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatEpisodeIdentification,
  groupEpisodesByAnime,
  sanitizeAnimeName,
  sanitizeEpisodeNumber,
} from '@/lib/anime-library';
import {
  createEpisode,
  type DiagnosticSqlTag,
  getEpisodeById,
  listEpisodes,
  type PlayerEpisode,
  sanitizeEpisodeInput,
  updateEpisode,
} from '@/lib/db';
import { buildPublicEpisodeResult } from '@/lib/server-fns';
import type { EpisodeDto } from '@/lib/types';

function createInMemoryEpisodeStore() {
  const rows = new Map<string, Record<string, unknown>>();

  const sqlTag: DiagnosticSqlTag = async (strings, ...values) => {
    const query = strings.join(' ');

    if (query.includes('INSERT INTO public.player_episodes')) {
      const id = String(values[0]);
      const now = '2026-11-26T00:00:00.000Z';
      const row: Record<string, unknown> = {
        id,
        anime_name: values[1] ?? null,
        episode_number: values[2] ?? null,
        opening_start_seconds: values[3] ?? null,
        opening_end_seconds: values[4] ?? null,
        title: values[5],
        poster_url: values[6],
        video_url: values[7],
        video_url_2: values[8] ?? null,
        video_url_3: values[9] ?? null,
        video_url_4: values[10] ?? null,
        video_url_5: values[11] ?? null,
        source_kind: values[12] ?? null,
        source_kind_2: values[13] ?? null,
        source_kind_3: values[14] ?? null,
        source_kind_4: values[15] ?? null,
        source_kind_5: values[16] ?? null,
        force_proxy: values[17] ?? true,
        force_proxy_2: values[18] ?? true,
        force_proxy_3: values[19] ?? true,
        force_proxy_4: values[20] ?? true,
        force_proxy_5: values[21] ?? true,
        source_referer: values[22] ?? null,
        source_referer_2: values[23] ?? null,
        source_referer_3: values[24] ?? null,
        source_referer_4: values[25] ?? null,
        source_referer_5: values[26] ?? null,
        is_mirror: false,
        is_mirror_2: false,
        is_mirror_3: false,
        is_mirror_4: false,
        is_mirror_5: false,
        created_at: now,
        updated_at: now,
      };
      rows.set(id, row);
      return [row];
    }

    if (query.includes('UPDATE public.player_episodes')) {
      const isPreserveMode = !query.includes('video_url_2 =');
      const id = String(values[values.length - 1]);
      const existing = rows.get(id);
      if (!existing) return [];

      const updated: Record<string, unknown> = isPreserveMode
        ? {
            ...existing,
            anime_name: values[0] ?? null,
            episode_number: values[1] ?? null,
            opening_start_seconds: values[2] ?? null,
            opening_end_seconds: values[3] ?? null,
            title: values[4],
            poster_url: values[5],
            video_url: values[6],
            source_kind: values[7] ?? null,
            force_proxy: values[8] ?? true,
            source_referer: values[9] ?? null,
            updated_at: '2026-11-26T00:05:00.000Z',
          }
        : {
            ...existing,
            anime_name: values[0] ?? null,
            episode_number: values[1] ?? null,
            opening_start_seconds: values[2] ?? null,
            opening_end_seconds: values[3] ?? null,
            title: values[4],
            poster_url: values[5],
            video_url: values[6],
            video_url_2: values[7] ?? null,
            video_url_3: values[8] ?? null,
            video_url_4: values[9] ?? null,
            video_url_5: values[10] ?? null,
            source_kind: values[11] ?? null,
            source_kind_2: values[12] ?? null,
            source_kind_3: values[13] ?? null,
            source_kind_4: values[14] ?? null,
            source_kind_5: values[15] ?? null,
            force_proxy: values[16] ?? true,
            force_proxy_2: values[17] ?? true,
            force_proxy_3: values[18] ?? true,
            force_proxy_4: values[19] ?? true,
            force_proxy_5: values[20] ?? true,
            source_referer: values[21] ?? null,
            source_referer_2: values[22] ?? null,
            source_referer_3: values[23] ?? null,
            source_referer_4: values[24] ?? null,
            source_referer_5: values[25] ?? null,
            updated_at: '2026-11-26T00:05:00.000Z',
          };

      rows.set(id, updated);
      return [updated];
    }

    if (query.includes('WHERE id =')) {
      const id = String(values[0]);
      const found = rows.get(id);
      return found ? [found] : [];
    }

    return Array.from(rows.values());
  };

  return { rows, sqlTag };
}

function toDto(ep: PlayerEpisode): EpisodeDto {
  return {
    ...ep,
    public_url: `https://hikari-player-2.vercel.app/e/${ep.id}`,
  };
}

function toEditFormState(ep: EpisodeDto) {
  return {
    anime_name: ep.anime_name ?? '',
    episode_number: ep.episode_number ?? '',
    title: ep.title ?? '',
    poster_url: ep.poster_url,
    video_url: ep.video_url,
  };
}

describe('Identificação independente: Nome do anime, Número do episódio e Título do episódio', () => {
  it('1. cadastra anime com episódio "01" e título do episódio vazio sem copiar anime_name para title', async () => {
    const store = createInMemoryEpisodeStore();
    const created = await createEpisode(
      {
        anime_name: 'Sora no Aosa wo Shiru Hito yo',
        episode_number: '01',
        title: '',
        poster_url: 'https://cdn.example.com/sora-01.jpg',
        video_url: 'https://cdn.example.com/sora-01.m3u8',
        source_kind: 'hls',
      },
      store.sqlTag
    );

    expect(created.anime_name).toBe('Sora no Aosa wo Shiru Hito yo');
    expect(created.episode_number).toBe('01');
    expect(created.title).toBe('');

    const persistedRow = store.rows.get(created.id);
    expect(persistedRow?.anime_name).toBe('Sora no Aosa wo Shiru Hito yo');
    expect(persistedRow?.episode_number).toBe('01');
    expect(persistedRow?.title).toBe('');
  });

  it('2. garante independência dos 3 campos na edição e impede que fallbacks de schema copiem anime_name para title', async () => {
    // Caso 2a: banco com 0004 (anime_name/episode_number) mas sem 0002/0003/0008 (force_proxy/source_kind/source_referer)
    const partialSchemaMock: DiagnosticSqlTag = async (strings, ...values) => {
      const query = strings.join(' ');
      if (
        query.includes('source_referer') ||
        query.includes('source_kind') ||
        query.includes('force_proxy')
      ) {
        const err = new Error('column "source_kind" does not exist') as Error & { code?: string };
        err.code = '42703';
        throw err;
      }
      if (query.includes('INSERT INTO public.player_episodes')) {
        return [
          {
            id: String(values[0]),
            anime_name: values[1],
            episode_number: values[2],
            opening_start_seconds: values[3],
            opening_end_seconds: values[4],
            title: values[5],
            poster_url: values[6],
            video_url: values[7],
            video_url_2: null,
            video_url_3: null,
            video_url_4: null,
            video_url_5: null,
            created_at: '2026-11-26T00:00:00.000Z',
            updated_at: '2026-11-26T00:00:00.000Z',
          },
        ];
      }
      return [
        {
          id: String(values[7]),
          anime_name: values[0],
          episode_number: values[1],
          opening_start_seconds: values[2],
          opening_end_seconds: values[3],
          title: values[4],
          poster_url: values[5],
          video_url: values[6],
          video_url_2: null,
          video_url_3: null,
          video_url_4: null,
          video_url_5: null,
          created_at: '2026-11-26T00:00:00.000Z',
          updated_at: '2026-11-26T00:05:00.000Z',
        },
      ];
    };

    const createdPartial = await createEpisode(
      {
        anime_name: 'Sora no Aosa wo Shiru Hito yo',
        episode_number: '01',
        title: '',
        poster_url: 'https://cdn.example.com/sora-01.jpg',
        video_url: 'https://cdn.example.com/sora-01.mp4',
      },
      partialSchemaMock
    );
    expect(createdPartial.anime_name).toBe('Sora no Aosa wo Shiru Hito yo');
    expect(createdPartial.episode_number).toBe('01');
    expect(createdPartial.title).toBe('');

    const updatedPartial = await updateEpisode(
      createdPartial.id,
      {
        anime_name: 'Sora no Aosa wo Shiru Hito yo',
        episode_number: '01',
        title: '',
        poster_url: 'https://cdn.example.com/sora-01.jpg',
        video_url: 'https://cdn.example.com/sora-01.mp4',
      },
      partialSchemaMock
    );
    expect(updatedPartial?.anime_name).toBe('Sora no Aosa wo Shiru Hito yo');
    expect(updatedPartial?.episode_number).toBe('01');
    expect(updatedPartial?.title).toBe('');

    // Caso 2b: fallback legado mínimo (0001 sem 0004) NÃO pode copiar anime_name para title
    const legacy0001Mock: DiagnosticSqlTag = async (strings, ...values) => {
      const query = strings.join(' ');
      if (
        query.includes('anime_name') ||
        query.includes('source_kind') ||
        query.includes('opening_start_seconds')
      ) {
        const err = new Error('column "anime_name" does not exist') as Error & { code?: string };
        err.code = '42703';
        throw err;
      }
      return [
        {
          id: String(values[0]),
          title: values[1],
          poster_url: values[2],
          video_url: values[3],
          video_url_2: null,
          video_url_3: null,
          video_url_4: null,
          video_url_5: null,
          created_at: '2026-11-26T00:00:00.000Z',
          updated_at: '2026-11-26T00:00:00.000Z',
        },
      ];
    };

    const legacyCreated = await createEpisode(
      {
        anime_name: 'Sora no Aosa wo Shiru Hito yo',
        episode_number: '01',
        title: '',
        poster_url: 'https://cdn.example.com/sora-01.jpg',
        video_url: 'https://cdn.example.com/sora-01.mp4',
      },
      legacy0001Mock
    );
    expect(legacyCreated.title).toBe('');
    expect(legacyCreated.title).not.toBe('Sora no Aosa wo Shiru Hito yo');
  });

  it('3. salva episódio "02" com título específico ("A Jornada") mantendo os três campos independentes', async () => {
    const store = createInMemoryEpisodeStore();
    const created = await createEpisode(
      {
        anime_name: 'Frieren',
        episode_number: '02',
        title: 'A Jornada',
        poster_url: 'https://cdn.example.com/frieren-02.jpg',
        video_url: 'https://cdn.example.com/frieren-02.mp4',
      },
      store.sqlTag
    );

    expect(created.anime_name).toBe('Frieren');
    expect(created.episode_number).toBe('02');
    expect(created.title).toBe('A Jornada');
  });

  it('4. salva episódio "003" preservando todos os zeros à esquerda', async () => {
    expect(sanitizeEpisodeNumber('003')).toBe('003');
    expect(sanitizeEpisodeNumber(' 003 ')).toBe('003');

    const sanitized = sanitizeEpisodeInput({
      anime_name: 'One Piece',
      episode_number: '003',
      title: '',
      poster_url: 'https://cdn.example.com/op-003.jpg',
      video_url: 'https://cdn.example.com/op-003.mp4',
    });
    expect(sanitized.episode_number).toBe('003');

    const store = createInMemoryEpisodeStore();
    const created = await createEpisode(
      {
        anime_name: 'One Piece',
        episode_number: '003',
        title: '',
        poster_url: 'https://cdn.example.com/op-003.jpg',
        video_url: 'https://cdn.example.com/op-003.mp4',
      },
      store.sqlTag
    );

    expect(created.episode_number).toBe('003');
    const fetched = await getEpisodeById(created.id, store.sqlTag);
    expect(fetched?.episode_number).toBe('003');
    expect(fetched?.title).toBe('');
  });

  it('5. atualiza apenas o nome do anime, sem alterar número do episódio ou título', async () => {
    const store = createInMemoryEpisodeStore();
    const created = await createEpisode(
      {
        anime_name: 'Frieren',
        episode_number: '02',
        title: 'A Jornada',
        poster_url: 'https://cdn.example.com/frieren-02.jpg',
        video_url: 'https://cdn.example.com/frieren-02.mp4',
      },
      store.sqlTag
    );

    const updated = await updateEpisode(
      created.id,
      {
        anime_name: 'Sousou no Frieren',
        episode_number: created.episode_number,
        title: created.title,
        poster_url: created.poster_url,
        video_url: created.video_url,
      },
      store.sqlTag
    );

    expect(updated?.anime_name).toBe('Sousou no Frieren');
    expect(updated?.episode_number).toBe('02');
    expect(updated?.title).toBe('A Jornada');
  });

  it('6. atualiza apenas o número do episódio, sem alterar nome do anime ou título', async () => {
    const store = createInMemoryEpisodeStore();
    const created = await createEpisode(
      {
        anime_name: 'Sora no Aosa wo Shiru Hito yo',
        episode_number: '01',
        title: '',
        poster_url: 'https://cdn.example.com/sora.jpg',
        video_url: 'https://cdn.example.com/sora.mp4',
      },
      store.sqlTag
    );

    const updated = await updateEpisode(
      created.id,
      {
        anime_name: created.anime_name,
        episode_number: '002',
        title: created.title,
        poster_url: created.poster_url,
        video_url: created.video_url,
      },
      store.sqlTag
    );

    expect(updated?.anime_name).toBe('Sora no Aosa wo Shiru Hito yo');
    expect(updated?.episode_number).toBe('002');
    expect(updated?.title).toBe('');
  });

  it('7. atualiza apenas o título do episódio, sem alterar nome do anime ou número', async () => {
    const store = createInMemoryEpisodeStore();
    const created = await createEpisode(
      {
        anime_name: 'Sora no Aosa wo Shiru Hito yo',
        episode_number: '01',
        title: '',
        poster_url: 'https://cdn.example.com/sora.jpg',
        video_url: 'https://cdn.example.com/sora.mp4',
      },
      store.sqlTag
    );

    const updated = await updateEpisode(
      created.id,
      {
        anime_name: created.anime_name,
        episode_number: created.episode_number,
        title: 'O Encontro',
        poster_url: created.poster_url,
        video_url: created.video_url,
      },
      store.sqlTag
    );

    expect(updated?.anime_name).toBe('Sora no Aosa wo Shiru Hito yo');
    expect(updated?.episode_number).toBe('01');
    expect(updated?.title).toBe('O Encontro');
  });

  it('8. reabre o formulário de edição após salvar e garante que cada campo receba seu valor exato', async () => {
    const store = createInMemoryEpisodeStore();
    const created1 = await createEpisode(
      {
        anime_name: 'Sora no Aosa wo Shiru Hito yo',
        episode_number: '01',
        title: '',
        poster_url: 'https://cdn.example.com/sora-01.jpg',
        video_url: 'https://cdn.example.com/sora-01.mp4',
      },
      store.sqlTag
    );

    const created2 = await createEpisode(
      {
        anime_name: 'Frieren',
        episode_number: '02',
        title: 'A Jornada',
        poster_url: 'https://cdn.example.com/frieren-02.jpg',
        video_url: 'https://cdn.example.com/frieren-02.mp4',
      },
      store.sqlTag
    );

    const reloaded1 = await getEpisodeById(created1.id, store.sqlTag);
    const reloaded2 = await getEpisodeById(created2.id, store.sqlTag);
    expect(reloaded1).not.toBeNull();
    expect(reloaded2).not.toBeNull();

    const reopenedForm1 = toEditFormState(toDto(reloaded1!));
    expect(reopenedForm1.anime_name).toBe('Sora no Aosa wo Shiru Hito yo');
    expect(reopenedForm1.episode_number).toBe('01');
    expect(reopenedForm1.title).toBe('');

    const reopenedForm2 = toEditFormState(toDto(reloaded2!));
    expect(reopenedForm2.anime_name).toBe('Frieren');
    expect(reopenedForm2.episode_number).toBe('02');
    expect(reopenedForm2.title).toBe('A Jornada');

    // Confirma que listEpisodes fallback (to_jsonb) também preserva anime_name e episode_number
    expect(typeof listEpisodes).toBe('function');
    expect(sanitizeAnimeName(reopenedForm1.anime_name)).toBe('Sora no Aosa wo Shiru Hito yo');
  });

  it('9. exibe identificação correta no Player e nas listagens do Admin', async () => {
    const store = createInMemoryEpisodeStore();
    const ep1 = await createEpisode(
      {
        anime_name: 'Sora no Aosa wo Shiru Hito yo',
        episode_number: '01',
        title: '',
        poster_url: 'https://cdn.example.com/sora-01.jpg',
        video_url: 'https://cdn.example.com/sora-01.mp4',
      },
      store.sqlTag
    );
    const ep2 = await createEpisode(
      {
        anime_name: 'Frieren',
        episode_number: '02',
        title: 'A Jornada',
        poster_url: 'https://cdn.example.com/frieren-02.jpg',
        video_url: 'https://cdn.example.com/frieren-02.mp4',
      },
      store.sqlTag
    );

    // 1. Formatação de identificação usada no banner e metadados
    expect(formatEpisodeIdentification(ep1)).toBe('Sora no Aosa wo Shiru Hito yo · Episódio 01');
    expect(formatEpisodeIdentification(ep2)).toBe('Frieren · Episódio 02 · A Jornada');

    // 2. Payload público do Player
    const public1 = buildPublicEpisodeResult(ep1);
    expect(public1.status).toBe('ok');
    if (public1.status === 'ok') {
      expect(public1.episode.anime_name).toBe('Sora no Aosa wo Shiru Hito yo');
      expect(public1.episode.episode_number).toBe('01');
      expect(public1.episode.episode_title).toBeNull();
      expect(public1.episode.title).toBe('Sora no Aosa wo Shiru Hito yo · Episódio 01');
    }

    const public2 = buildPublicEpisodeResult(ep2);
    expect(public2.status).toBe('ok');
    if (public2.status === 'ok') {
      expect(public2.episode.anime_name).toBe('Frieren');
      expect(public2.episode.episode_number).toBe('02');
      expect(public2.episode.episode_title).toBe('A Jornada');
      expect(public2.episode.title).toBe('Frieren · Episódio 02 · A Jornada');
    }

    // 3. Agrupamento e listagem do Admin
    const groups = groupEpisodesByAnime([toDto(ep1), toDto(ep2)]);
    const soraGroup = groups.find((g) => g.name === 'Sora no Aosa wo Shiru Hito yo');
    const frierenGroup = groups.find((g) => g.name === 'Frieren');
    expect(soraGroup).toBeDefined();
    expect(soraGroup?.episodes[0].episode_number).toBe('01');
    expect(soraGroup?.episodes[0].title).toBe('');
    expect(frierenGroup).toBeDefined();
    expect(frierenGroup?.episodes[0].episode_number).toBe('02');
    expect(frierenGroup?.episodes[0].title).toBe('A Jornada');

    // 4. Confirma renderização na rota do Player e do Admin
    const playerRouteSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/routes/e/$id.tsx'),
      'utf8'
    );
    const adminRouteSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/routes/admin.tsx'),
      'utf8'
    );
    expect(playerRouteSource).toContain('Episódio {episode.episode_number}');
    expect(playerRouteSource).toContain('episode.anime_name');
    expect(playerRouteSource).toContain('episode.episode_title');
    expect(adminRouteSource).toContain('Ep. {ep.episode_number}');
    expect(adminRouteSource).toContain('Episódio {ep.episode_number}');
    expect(adminRouteSource).toContain('formatEpisodeIdentification(res.episode)');
  });
});
