import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EpisodePlayer } from '@/components/EpisodePlayer';
import {
  createEpisode,
  type DiagnosticSqlTag,
  getEpisodeById,
  type PlayerEpisode,
  sanitizeEpisodeInput,
  updateEpisode,
} from '@/lib/db';
import {
  collectEpisodeSources,
  getEpisodeMirrorInfo,
  getNextFallbackSourceIndex,
} from '@/lib/video-sources';

const R2_BROKEN_URL =
  'https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/animes/frieren/ep-01.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef';
const BLOB_MIRROR_URL =
  'https://q70piqtcusyiwtbz.public.blob.vercel-storage.com/mirrors/frieren/ep_r2_mirror_01.mp4';

function makeEpisodeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'ep_r2_mirror_01',
    anime_name: 'Frieren',
    episode_number: '01',
    opening_start_seconds: 90,
    opening_end_seconds: 180,
    title: 'O Fim da Jornada',
    poster_url: 'https://cdn.example.com/frieren-01.jpg',
    video_url: R2_BROKEN_URL,
    video_url_2: BLOB_MIRROR_URL,
    video_url_3: null,
    video_url_4: null,
    video_url_5: null,
    source_kind: 'mp4',
    source_kind_2: 'mp4',
    source_kind_3: null,
    source_kind_4: null,
    source_kind_5: null,
    force_proxy: true,
    force_proxy_2: false,
    force_proxy_3: true,
    force_proxy_4: true,
    force_proxy_5: true,
    is_mirror: false,
    is_mirror_2: true,
    is_mirror_3: false,
    is_mirror_4: false,
    is_mirror_5: false,
    source_referer: 'https://provider.example/watch',
    source_referer_2: null,
    source_referer_3: null,
    source_referer_4: null,
    source_referer_5: null,
    created_at: '2026-11-20T12:00:00.000Z',
    updated_at: '2026-11-20T12:00:00.000Z',
    ...overrides,
  };
}

describe('Remoção do Player 1 quebrado e exibição da URL real do espelho', () => {
  it('1 e 2. limpa o Player 1, persiste vazio no banco e mantém vazio ao reabrir o episódio', async () => {
    let dbRow = makeEpisodeRow();
    const queries: string[] = [];

    const mockSql: DiagnosticSqlTag = async (strings, ...values) => {
      const sqlText = strings.join(' ');
      queries.push(sqlText);
      if (sqlText.includes('SELECT')) {
        return [{ ...dbRow }];
      }
      if (sqlText.includes('UPDATE')) {
        dbRow = {
          ...dbRow,
          anime_name: values[0],
          episode_number: values[1],
          opening_start_seconds: values[2],
          opening_end_seconds: values[3],
          title: values[4],
          poster_url: values[5],
          video_url: values[6],
          source_kind: values[7],
          force_proxy: values[8],
          source_referer: values[9],
          updated_at: '2026-11-25T22:00:00.000Z',
        };
        return [{ ...dbRow }];
      }
      return [];
    };

    const updated = await updateEpisode(
      'ep_r2_mirror_01',
      {
        anime_name: 'Frieren',
        episode_number: '01',
        opening_start_seconds: 90,
        opening_end_seconds: 180,
        title: 'O Fim da Jornada',
        poster_url: 'https://cdn.example.com/frieren-01.jpg',
        video_url: '',
        source_kind: '',
        source_referer: null,
        force_proxy: true,
      },
      mockSql
    );

    expect(updated).not.toBeNull();
    expect(updated?.video_url).toBe('');
    expect(updated?.source_kind).toBeNull();
    expect(updated?.source_referer).toBeNull();

    // Ao recarregar do banco (simula reabrir o formulário de edição no Admin)
    const reloaded = await getEpisodeById('ep_r2_mirror_01', mockSql);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.video_url).toBe('');
    expect(reloaded?.source_kind).toBeNull();
    expect(reloaded?.source_referer).toBeNull();
    expect(reloaded?.title).toBe('O Fim da Jornada');
    expect(reloaded?.opening_start_seconds).toBe(90);
    expect(reloaded?.opening_end_seconds).toBe(180);
  });

  it('3 e 4. mantém URL exata do espelho no Player 2 e preserva is_mirror_2, source_kind_2, force_proxy_2 e source_referer_2 inalterados', async () => {
    let dbRow = makeEpisodeRow({ source_referer_2: 'https://blob-cdn.example/' });
    let updateSql = '';

    const mockSql: DiagnosticSqlTag = async (strings, ...values) => {
      const sqlText = strings.join(' ');
      if (sqlText.includes('SELECT')) {
        return [{ ...dbRow }];
      }
      if (sqlText.includes('UPDATE')) {
        updateSql = sqlText;
        dbRow = {
          ...dbRow,
          video_url: values[6],
          source_kind: values[7],
          force_proxy: values[8],
          source_referer: values[9],
        };
        return [{ ...dbRow }];
      }
      return [];
    };

    const updated = await updateEpisode(
      'ep_r2_mirror_01',
      {
        anime_name: 'Frieren',
        episode_number: '01',
        opening_start_seconds: 90,
        opening_end_seconds: 180,
        title: 'O Fim da Jornada',
        poster_url: 'https://cdn.example.com/frieren-01.jpg',
        video_url: '',
        source_kind: '',
        source_referer: null,
      },
      mockSql
    );

    // SQL UPDATE no modo Player único nunca toca as colunas do Player 2..5 nem is_mirror*
    expect(updateSql).not.toContain('video_url_2 =');
    expect(updateSql).not.toContain('source_kind_2 =');
    expect(updateSql).not.toContain('force_proxy_2 =');
    expect(updateSql).not.toContain('source_referer_2 =');
    expect(updateSql).not.toContain('is_mirror_2 =');

    expect(updated?.video_url).toBe('');
    expect(updated?.video_url_2).toBe(BLOB_MIRROR_URL);
    expect(updated?.is_mirror_2).toBe(true);
    expect(updated?.source_kind_2).toBe('mp4');
    expect(updated?.force_proxy_2).toBe(false);
    expect(updated?.source_referer_2).toBe('https://blob-cdn.example/');
  });

  it('5. limpar ou remover Player 1 nunca chama exclusão de objetos no Vercel Blob', () => {
    const dbSource = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/db.ts'), 'utf8');
    const adminSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/routes/admin.tsx'),
      'utf8'
    );
    const serverFnsSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/server-fns.ts'),
      'utf8'
    );

    expect(dbSource).not.toContain('@vercel/blob');
    expect(dbSource).not.toContain('del(');
    expect(adminSource).not.toContain('@vercel/blob');
    expect(adminSource).not.toContain('del(');
    expect(serverFnsSource).not.toContain('@vercel/blob');
  });

  it('6. collectEpisodeSources() omite Player 1 removido e retorna apenas o Player 2 (espelho no Vercel Blob)', () => {
    const episodeAfterClear: PlayerEpisode = {
      ...(makeEpisodeRow({ video_url: '', source_kind: null, source_referer: null }) as unknown as PlayerEpisode),
    };

    const sources = collectEpisodeSources(episodeAfterClear);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      slot: 2,
      label: 'Player 2',
      kind: 'mp4',
      resolvedUrl: BLOB_MIRROR_URL,
      needsProxy: false,
      isMirror: true,
    });
    expect(sources.some((s) => s.resolvedUrl.includes('r2.cloudflarestorage.com'))).toBe(false);
    expect(getNextFallbackSourceIndex(sources, 0, new Set([2]))).toBeNull();
  });

  it('7. EpisodePlayer com apenas Player 2 (espelho) não tenta carregar R2 removido nem exibe aviso de "Player 1 indisponível"', () => {
    const html = renderToStaticMarkup(
      React.createElement(EpisodePlayer, {
        title: 'Frieren · Episódio 01',
        posterUrl: 'https://cdn.example.com/frieren-01.jpg',
        sources: [
          {
            slot: 2,
            label: 'Player 2',
            rawUrl: BLOB_MIRROR_URL,
            resolvedUrl: BLOB_MIRROR_URL,
            playUrl: BLOB_MIRROR_URL,
            kind: 'mp4',
            provider: 'direct',
            needsProxy: false,
            requiresServerResolve: false,
            formatLabel: 'MP4',
            isMirror: true,
          },
        ],
      })
    );

    expect(html).not.toContain('r2.cloudflarestorage.com');
    expect(html).not.toContain('Player 1 indisponível');
    expect(html).not.toContain('alternando para');
    expect(html).toContain('Clique para reproduzir');
    expect(html).toContain('Reproduzir Frieren');
  });

  it('8. exibe URL real do espelho no Admin (sem jamais tratar R2 como espelho nem inventar URL) com ações de copiar e abrir', () => {
    const epWithMirror = makeEpisodeRow();
    const info = getEpisodeMirrorInfo(epWithMirror as unknown as PlayerEpisode);

    expect(info).toEqual({
      hasMirror: true,
      slot: 2,
      url: BLOB_MIRROR_URL,
      kind: 'mp4',
      isVercelBlob: true,
    });

    // Mesmo se is_mirror=true estivesse marcado por engano em um link R2, jamais exibe URL R2 como espelho
    const epWithWrongR2Flag = makeEpisodeRow({
      video_url: R2_BROKEN_URL,
      is_mirror: true,
      video_url_2: null,
      is_mirror_2: false,
    });
    const wrongFlagInfo = getEpisodeMirrorInfo(epWithWrongR2Flag as unknown as PlayerEpisode);
    expect(wrongFlagInfo.hasMirror).toBe(false);
    expect(wrongFlagInfo.url).toBeNull();

    // Episódio sem nenhum espelho retorna estado informativo sem URL inventada
    const epWithoutMirror = makeEpisodeRow({
      video_url_2: null,
      is_mirror_2: false,
    });
    const noMirrorInfo = getEpisodeMirrorInfo(epWithoutMirror as unknown as PlayerEpisode);
    expect(noMirrorInfo).toEqual({
      hasMirror: false,
      slot: null,
      url: null,
      kind: null,
      isVercelBlob: false,
    });

    // Verifica UI do Admin possui botão de remover Player 1, exibição da URL real do espelho, cópia e link externo
    const adminSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/routes/admin.tsx'),
      'utf8'
    );
    expect(adminSource).toContain('Remover fonte');
    expect(adminSource).toContain('Copiar URL do espelho');
    expect(adminSource).toContain('Abrir espelho');
    expect(adminSource).toContain('Cópia armazenada no Vercel Blob');
    expect(adminSource).toContain('Nenhuma cópia espelhada armazenada no Vercel Blob');
  });

  it('9. episódios sem espelho ou sem nenhuma fonte válida continuam exigindo URL válida e funcionando normalmente', async () => {
    // Rejeita criação sem nenhuma fonte
    await expect(
      createEpisode({
        anime_name: 'Anime Sem Fonte',
        episode_number: '01',
        title: 'Episódio 1',
        poster_url: 'https://cdn.example.com/poster.jpg',
        video_url: '',
      })
    ).rejects.toThrow(/Player 1 inválido|fonte de vídeo/i);

    // Rejeita atualização limpando Player 1 quando o episódio no banco NÃO tem fontes nos slots 2..5
    const rowWithoutMirror = makeEpisodeRow({
      video_url_2: null,
      is_mirror_2: false,
    });
    const mockSqlNoMirror: DiagnosticSqlTag = async (strings) => {
      if (strings.join(' ').includes('SELECT')) {
        return [{ ...rowWithoutMirror }];
      }
      return [];
    };

    await expect(
      updateEpisode(
        'ep_r2_mirror_01',
        {
          anime_name: 'Frieren',
          episode_number: '01',
          title: 'Sem Espelho',
          poster_url: 'https://cdn.example.com/frieren-01.jpg',
          video_url: '',
        },
        mockSqlNoMirror
      )
    ).rejects.toThrow(/Player 1 inválido|fonte de vídeo/i);

    // Episódio normal com Player 1 válido e sem espelho continua passando
    const validNormal = sanitizeEpisodeInput({
      anime_name: 'Frieren',
      episode_number: '01',
      title: 'Normal',
      poster_url: 'https://cdn.example.com/frieren-01.jpg',
      video_url: 'https://cdn.example.com/video.m3u8',
      source_kind: 'hls',
    });
    expect(validNormal.video_url).toBe('https://cdn.example.com/video.m3u8');
    expect(validNormal.source_kind).toBe('hls');
  });

  it('10. editar outros campos com Player 1 já vazio e Player 2 existente preserva Player 1 vazio e não restaura URL antiga', async () => {
    let dbRow = makeEpisodeRow({
      video_url: '',
      source_kind: null,
      source_referer: null,
    });

    const mockSql: DiagnosticSqlTag = async (strings, ...values) => {
      const sqlText = strings.join(' ');
      if (sqlText.includes('SELECT')) {
        return [{ ...dbRow }];
      }
      if (sqlText.includes('UPDATE')) {
        dbRow = {
          ...dbRow,
          anime_name: values[0],
          episode_number: values[1],
          opening_start_seconds: values[2],
          opening_end_seconds: values[3],
          title: values[4],
          poster_url: values[5],
          video_url: values[6],
          source_kind: values[7],
          force_proxy: values[8],
          source_referer: values[9],
          updated_at: '2026-11-25T23:00:00.000Z',
        };
        return [{ ...dbRow }];
      }
      return [];
    };

    const updated = await updateEpisode(
      'ep_r2_mirror_01',
      {
        anime_name: 'Frieren: Além da Jornada',
        episode_number: '01',
        opening_start_seconds: 95,
        opening_end_seconds: 185,
        title: 'A Jornada Começa (Editado)',
        poster_url: 'https://cdn.example.com/frieren-01-new.jpg',
        video_url: '',
        source_kind: '',
        source_referer: null,
      },
      mockSql
    );

    expect(updated).not.toBeNull();
    expect(updated?.anime_name).toBe('Frieren: Além da Jornada');
    expect(updated?.title).toBe('A Jornada Começa (Editado)');
    expect(updated?.poster_url).toBe('https://cdn.example.com/frieren-01-new.jpg');
    expect(updated?.opening_start_seconds).toBe(95);
    expect(updated?.opening_end_seconds).toBe(185);
    expect(updated?.video_url).toBe('');
    expect(updated?.video_url_2).toBe(BLOB_MIRROR_URL);
    expect(updated?.is_mirror_2).toBe(true);
    expect(updated?.source_kind_2).toBe('mp4');
    expect(updated?.force_proxy_2).toBe(false);
  });
});
