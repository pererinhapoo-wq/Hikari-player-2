import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDubbedEpisodeTitle } from '@/lib/anime-library';
import {
  buildDubbedEpisodeInput,
  createEpisode,
  type DiagnosticSqlTag,
  duplicateEpisodeToDubbed,
  getEpisodeById,
  type PlayerEpisode,
  updateEpisode,
} from '@/lib/db';

function createInMemoryEpisodeStore() {
  const rows = new Map<string, Record<string, unknown>>();
  const queries: string[] = [];

  const sqlTag: DiagnosticSqlTag = async (strings, ...values) => {
    const query = strings.join(' ');
    queries.push(query);

    if (query.includes('INSERT INTO public.player_episodes')) {
      const id = String(values[0]);
      if (rows.has(id)) {
        const err = new Error('duplicate key value violates unique constraint') as Error & {
          code?: string;
        };
        err.code = '23505';
        throw err;
      }

      const now = '2026-11-27T10:00:00.000Z';
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
            updated_at: '2026-11-27T10:15:00.000Z',
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
            updated_at: '2026-11-27T10:15:00.000Z',
          };

      rows.set(id, updated);
      return [updated];
    }

    if (query.includes('WHERE id =')) {
      const id = String(values[0]);
      const found = rows.get(id);
      return found ? [{ ...found }] : [];
    }

    return Array.from(rows.values()).map((r) => ({ ...r }));
  };

  return { rows, queries, sqlTag };
}

describe('Função "Duplicar para dublado"', () => {
  it('1. a duplicação cria um ID novo e exclusivo diferente do episódio original', async () => {
    const store = createInMemoryEpisodeStore();
    const original = await createEpisode(
      {
        anime_name: 'Fool Night',
        episode_number: '1',
        opening_start_seconds: 85,
        opening_end_seconds: 175,
        title: 'Fool Night - Episódio 1',
        poster_url: 'https://cdn.example.com/fool-night-1.jpg',
        video_url: 'https://cdn.example.com/fool-night-1-leg.m3u8',
        source_kind: 'hls',
      },
      store.sqlTag
    );

    const dubbed = await duplicateEpisodeToDubbed(original.id, store.sqlTag);

    expect(dubbed.id).toBeTruthy();
    expect(dubbed.id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    expect(dubbed.id).not.toBe(original.id);
    expect(store.rows.size).toBe(2);
  });

  it('2. o nome recebe apenas o sufixo "Dublado", sem alterar o original e sem duplicar "Dublado"', () => {
    expect(
      buildDubbedEpisodeTitle({
        anime_name: 'Fool Night',
        episode_number: '1',
        title: 'Fool Night - Episódio 1',
      })
    ).toBe('Fool Night - Episódio 1 Dublado');

    // Não duplica caso a operação seja repetida
    expect(
      buildDubbedEpisodeTitle({
        anime_name: 'Fool Night',
        episode_number: '1',
        title: 'Fool Night - Episódio 1 Dublado',
      })
    ).toBe('Fool Night - Episódio 1 Dublado');

    expect(
      buildDubbedEpisodeTitle({
        anime_name: 'Fool Night',
        episode_number: '1',
        title: 'Fool Night - Episódio 1 (dublado)',
      })
    ).toBe('Fool Night - Episódio 1 (dublado)');

    // Quando título está vazio, gera fallback identificável com sufixo Dublado
    expect(
      buildDubbedEpisodeTitle({
        anime_name: 'Fool Night',
        episode_number: '1',
        title: '',
      })
    ).toBe('Fool Night · Episódio 1 Dublado');
  });

  it('3. a thumbnail, anime associado, número do episódio, tempos da opening e configurações compatíveis são copiados', async () => {
    const store = createInMemoryEpisodeStore();
    const original = await createEpisode(
      {
        anime_name: 'Fool Night',
        episode_number: '01',
        opening_start_seconds: 90,
        opening_end_seconds: 180,
        title: 'Fool Night - Episódio 1',
        poster_url: 'https://cdn.example.com/fool-night-thumb.jpg',
        video_url: 'https://cdn.example.com/leg-1.m3u8',
        video_url_2: 'https://cdn.example.com/leg-2.mp4',
        video_url_3: 'https://cdn.example.com/leg-3.php',
        video_url_4: 'https://cdn.example.com/leg-4.m3u8',
        video_url_5: 'https://cdn.example.com/leg-5.mp4',
        source_kind: 'hls',
        source_referer: 'https://provider.example/watch',
        force_proxy: false,
      },
      store.sqlTag
    );

    const dubbed = await duplicateEpisodeToDubbed(original.id, store.sqlTag);

    expect(dubbed.anime_name).toBe('Fool Night');
    expect(dubbed.episode_number).toBe('01');
    expect(dubbed.title).toBe('Fool Night - Episódio 1 Dublado');
    expect(dubbed.poster_url).toBe('https://cdn.example.com/fool-night-thumb.jpg');
    expect(dubbed.opening_start_seconds).toBe(90);
    expect(dubbed.opening_end_seconds).toBe(180);
    expect(dubbed.force_proxy).toBe(false);
  });

  it('4. os cinco campos de URL de vídeo (video_url_1 até video_url_5) e metadados de fonte ficam vazios na nova versão', async () => {
    const store = createInMemoryEpisodeStore();
    const original = await createEpisode(
      {
        anime_name: 'Fool Night',
        episode_number: '1',
        opening_start_seconds: 60,
        opening_end_seconds: 150,
        title: 'Fool Night - Episódio 1',
        poster_url: 'https://cdn.example.com/poster.jpg',
        video_url: 'https://cdn.example.com/v1.m3u8',
        video_url_2: 'https://cdn.example.com/v2.mp4',
        video_url_3: 'https://cdn.example.com/v3.php',
        video_url_4: 'https://cdn.example.com/v4.m3u8',
        video_url_5: 'https://cdn.example.com/v5.mp4',
        source_kind: 'hls',
        source_kind_2: 'mp4',
        source_kind_3: 'iframe',
        source_referer: 'https://provider.example/',
      },
      store.sqlTag
    );

    const dubbed = await duplicateEpisodeToDubbed(original.id, store.sqlTag);

    expect(dubbed.video_url).toBe('');
    expect(dubbed.video_url_2).toBeNull();
    expect(dubbed.video_url_3).toBeNull();
    expect(dubbed.video_url_4).toBeNull();
    expect(dubbed.video_url_5).toBeNull();
    expect(dubbed.source_kind).toBeNull();
    expect(dubbed.source_kind_2).toBeNull();
    expect(dubbed.source_kind_3).toBeNull();
    expect(dubbed.source_kind_4).toBeNull();
    expect(dubbed.source_kind_5).toBeNull();
    expect(dubbed.source_referer).toBeNull();
    expect(dubbed.is_mirror).toBe(false);
    expect(dubbed.is_mirror_2).toBe(false);
  });

  it('5. o episódio original não sofre alterações e mantém todas as fontes e título sem "Legendado"', async () => {
    const store = createInMemoryEpisodeStore();
    const original = await createEpisode(
      {
        anime_name: 'Fool Night',
        episode_number: '1',
        opening_start_seconds: 90,
        opening_end_seconds: 180,
        title: 'Fool Night - Episódio 1',
        poster_url: 'https://cdn.example.com/poster.jpg',
        video_url: 'https://cdn.example.com/leg-1.m3u8',
        video_url_2: 'https://cdn.example.com/leg-2.mp4',
        source_kind: 'hls',
        source_referer: 'https://provider.example/ref',
      },
      store.sqlTag
    );

    const snapshotBefore = structuredClone(original);
    await duplicateEpisodeToDubbed(original.id, store.sqlTag);

    const originalAfter = await getEpisodeById(original.id, store.sqlTag);
    expect(originalAfter).toEqual(snapshotBefore);
    expect(originalAfter?.title).toBe('Fool Night - Episódio 1');
    expect(originalAfter?.title).not.toMatch(/legendado/i);
    expect(originalAfter?.video_url).toBe('https://cdn.example.com/leg-1.m3u8');
    expect(originalAfter?.video_url_2).toBe('https://cdn.example.com/leg-2.mp4');
  });

  it('6. a duplicação não sobrescreve registros existentes (usa INSERT exclusivo e verifica unicidade do ID)', async () => {
    const store = createInMemoryEpisodeStore();
    const existingOther = await createEpisode(
      {
        anime_name: 'Outro Anime',
        episode_number: '5',
        title: 'Episódio Existente',
        poster_url: 'https://cdn.example.com/other.jpg',
        video_url: 'https://cdn.example.com/other.mp4',
      },
      store.sqlTag
    );

    const original = await createEpisode(
      {
        anime_name: 'Fool Night',
        episode_number: '1',
        title: 'Fool Night - Episódio 1',
        poster_url: 'https://cdn.example.com/fool.jpg',
        video_url: 'https://cdn.example.com/fool.m3u8',
      },
      store.sqlTag
    );

    const queriesBeforeDup = store.queries.length;
    const dubbed = await duplicateEpisodeToDubbed(original.id, store.sqlTag);
    const dupQueries = store.queries.slice(queriesBeforeDup);

    // Verifica que consultou o ID candidato antes do INSERT e não executou UPDATE nem ON CONFLICT
    expect(dupQueries.some((q) => q.includes('WHERE id ='))).toBe(true);
    expect(dupQueries.some((q) => q.includes('INSERT INTO public.player_episodes'))).toBe(true);
    expect(dupQueries.some((q) => q.includes('UPDATE'))).toBe(false);
    expect(dupQueries.some((q) => /ON\s+CONFLICT/i.test(q))).toBe(false);

    expect(store.rows.size).toBe(3);
    expect(new Set([existingOther.id, original.id, dubbed.id]).size).toBe(3);
    expect((await getEpisodeById(existingOther.id, store.sqlTag))?.title).toBe('Episódio Existente');
  });

  it('7. a nova versão dublada pode ser editada e salva normalmente sem afetar o episódio original', async () => {
    const store = createInMemoryEpisodeStore();
    const original = await createEpisode(
      {
        anime_name: 'Fool Night',
        episode_number: '1',
        opening_start_seconds: 90,
        opening_end_seconds: 180,
        title: 'Fool Night - Episódio 1',
        poster_url: 'https://cdn.example.com/fool-1.jpg',
        video_url: 'https://cdn.example.com/fool-1-leg.m3u8',
        source_kind: 'hls',
      },
      store.sqlTag
    );

    const dubbed = await duplicateEpisodeToDubbed(original.id, store.sqlTag);
    expect(dubbed.video_url).toBe('');

    // Simula o admin preenchendo o link dublado no formulário e salvando normalmente
    const savedDubbed = await updateEpisode(
      dubbed.id,
      {
        anime_name: dubbed.anime_name,
        episode_number: dubbed.episode_number,
        opening_start_seconds: dubbed.opening_start_seconds,
        opening_end_seconds: dubbed.opening_end_seconds,
        title: dubbed.title,
        poster_url: dubbed.poster_url,
        video_url: 'https://cdn.example.com/fool-1-dub.mp4',
        source_kind: 'mp4',
        source_referer: null,
        force_proxy: dubbed.force_proxy,
      },
      store.sqlTag
    );

    expect(savedDubbed).not.toBeNull();
    expect(savedDubbed?.id).toBe(dubbed.id);
    expect(savedDubbed?.title).toBe('Fool Night - Episódio 1 Dublado');
    expect(savedDubbed?.video_url).toBe('https://cdn.example.com/fool-1-dub.mp4');
    expect(savedDubbed?.poster_url).toBe('https://cdn.example.com/fool-1.jpg');
    expect(savedDubbed?.opening_start_seconds).toBe(90);
    expect(savedDubbed?.opening_end_seconds).toBe(180);

    // Original permanece totalmente intacto após edição e salvamento da versão dublada
    const originalAfterSave = await getEpisodeById(original.id, store.sqlTag);
    expect(originalAfterSave?.title).toBe('Fool Night - Episódio 1');
    expect(originalAfterSave?.video_url).toBe('https://cdn.example.com/fool-1-leg.m3u8');
    expect(originalAfterSave?.source_kind).toBe('hls');
  });

  it('8. trata erros de duplicação sem criar registros incompletos e garante proteções na UI/server', async () => {
    const store = createInMemoryEpisodeStore();

    // Episódio inexistente falha sem criar nada
    await expect(duplicateEpisodeToDubbed('nao_existe_123', store.sqlTag)).rejects.toThrow(
      /não encontrado/i
    );
    expect(store.rows.size).toBe(0);

    // ID inválido falha sem consultar/criar nada
    await expect(duplicateEpisodeToDubbed('id inválido!', store.sqlTag)).rejects.toThrow(
      /inválido/i
    );
    expect(store.rows.size).toBe(0);

    // buildDubbedEpisodeInput valida opening incompleta antes de qualquer INSERT
    const corruptEpisode: PlayerEpisode = {
      id: 'corrupt_1',
      anime_name: 'Anime X',
      episode_number: '1',
      opening_start_seconds: 90,
      opening_end_seconds: null,
      title: 'Episódio 1',
      poster_url: 'https://cdn.example.com/poster.jpg',
      video_url: 'https://cdn.example.com/v.mp4',
      video_url_2: null,
      video_url_3: null,
      video_url_4: null,
      video_url_5: null,
      source_kind: null,
      source_kind_2: null,
      source_kind_3: null,
      source_kind_4: null,
      source_kind_5: null,
      force_proxy: true,
      force_proxy_2: true,
      force_proxy_3: true,
      force_proxy_4: true,
      force_proxy_5: true,
      is_mirror: false,
      is_mirror_2: false,
      is_mirror_3: false,
      is_mirror_4: false,
      is_mirror_5: false,
      created_at: '2026-11-27T00:00:00.000Z',
      updated_at: '2026-11-27T00:00:00.000Z',
    };
    expect(() => buildDubbedEpisodeInput(corruptEpisode)).toThrow(/opening/i);

    // Verifica proteção de cliques repetidos, botão e fluxo de abertura no admin.tsx e server-fns.ts
    const adminSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/routes/admin.tsx'),
      'utf8'
    );
    const serverFnsSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/server-fns.ts'),
      'utf8'
    );

    expect(serverFnsSource).toContain('adminDuplicateEpisodeFn');
    expect(serverFnsSource).toContain('requireAdminSession()');
    expect(serverFnsSource).toContain('duplicateEpisodeToDubbed(data.sourceId)');

    expect(adminSource).toContain('Duplicar para dublado');
    expect(adminSource).toContain('duplicateLockRef');
    expect(adminSource).toContain('duplicatingEpisodeId');
    expect(adminSource).toContain('adminDuplicateEpisodeFn');
    expect(adminSource).toContain('handleEditStart(res.episode)');
  });
});
