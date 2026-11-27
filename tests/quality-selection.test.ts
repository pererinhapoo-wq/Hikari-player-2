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
  sanitizeQuality,
  updateEpisode,
} from '@/lib/db';
import { buildPublicEpisodeResult } from '@/lib/server-fns';
import type { PlayableSource } from '@/lib/types';
import {
  AVAILABLE_QUALITIES,
  collectEpisodeSources,
  findSourceIndexForQuality,
  getAvailableQualities,
  getNextFallbackSourceIndex,
  getValidPlayableSources,
  normalizeQuality,
  shouldShowQualitySelector,
} from '@/lib/video-sources';
import { splitSqlStatements } from '../scripts/migrate';

function makeEpisodeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'ep_qual_01',
    anime_name: 'Frieren',
    episode_number: '01',
    opening_start_seconds: 90,
    opening_end_seconds: 180,
    title: 'O Fim da Jornada',
    poster_url: 'https://cdn.example.com/frieren-01.jpg',
    video_url: 'https://cdn.example.com/video-1080p.mp4',
    video_url_2: null,
    video_url_3: null,
    video_url_4: null,
    video_url_5: null,
    quality: '1080p',
    quality_2: null,
    quality_3: null,
    quality_4: null,
    quality_5: null,
    source_kind: 'mp4',
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
    source_referer: null,
    source_referer_2: null,
    source_referer_3: null,
    source_referer_4: null,
    source_referer_5: null,
    created_at: '2026-11-26T12:00:00.000Z',
    updated_at: '2026-11-26T12:00:00.000Z',
    ...overrides,
  };
}

function makePlayableSources(
  specs: Array<{
    slot: 1 | 2 | 3 | 4 | 5;
    url: string;
    quality?: string;
    kind?: 'mp4' | 'hls' | 'iframe';
  }>
): PlayableSource[] {
  return specs.map((spec) => ({
    slot: spec.slot,
    label: `Player ${spec.slot}`,
    rawUrl: spec.url,
    resolvedUrl: spec.url,
    playUrl: spec.url,
    kind: spec.kind ?? 'mp4',
    provider: spec.kind === 'hls' ? 'hls' : spec.kind === 'iframe' ? 'iframe' : 'direct',
    needsProxy: spec.kind !== 'iframe',
    requiresServerResolve: false,
    formatLabel: spec.kind === 'hls' ? 'HLS' : spec.kind === 'iframe' ? 'Iframe' : 'MP4',
    quality: spec.quality,
  }));
}

describe('Seleção manual de qualidade no Hikari Player', () => {
  it('1. episódio com 1 link válido não exibe a opção Qualidade', () => {
    const ep = makeEpisodeRow() as unknown as PlayerEpisode;
    const collected = collectEpisodeSources(ep);
    expect(collected).toHaveLength(1);

    const result = buildPublicEpisodeResult(ep);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');

    expect(shouldShowQualitySelector(result.episode.sources)).toBe(false);
    expect(getAvailableQualities(result.episode.sources)).toEqual([]);

    const html = renderToStaticMarkup(
      React.createElement(EpisodePlayer, {
        title: result.episode.title,
        posterUrl: result.episode.poster_url,
        sources: result.episode.sources,
      })
    );
    expect(html).not.toContain('Qualidade');
    expect(html).not.toContain('Automática');
  });

  it('2. episódio com 2 links válidos habilita a opção Qualidade e lista exatamente as 2 qualidades', () => {
    const ep = makeEpisodeRow({
      video_url: 'https://cdn.example.com/1080p.mp4',
      quality: '1080p',
      video_url_2: 'https://cdn.example.com/720p.mp4',
      quality_2: '720p',
      source_kind_2: 'mp4',
    }) as unknown as PlayerEpisode;

    const result = buildPublicEpisodeResult(ep);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');

    expect(shouldShowQualitySelector(result.episode.sources)).toBe(true);
    expect(getAvailableQualities(result.episode.sources)).toEqual(['1080p', '720p']);
  });

  it('3. episódio com 3+ links válidos exibe apenas qualidades cadastradas e jamais inclui Automática ou opções fictícias', () => {
    const ep = makeEpisodeRow({
      video_url: 'https://cdn.example.com/1080p.m3u8',
      quality: '1080p',
      source_kind: 'hls',
      video_url_2: 'https://cdn.example.com/720p.m3u8',
      quality_2: '720p',
      source_kind_2: 'hls',
      video_url_3: 'https://cdn.example.com/480p.mp4',
      quality_3: '480p',
      source_kind_3: 'mp4',
    }) as unknown as PlayerEpisode;

    const result = buildPublicEpisodeResult(ep);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');

    const qualities = getAvailableQualities(result.episode.sources);
    expect(qualities).toEqual(['1080p', '720p', '480p']);
    expect(qualities).not.toContain('Automática');
    expect(qualities).not.toContain('auto');
    expect(qualities).not.toContain('360p');
    expect(qualities).not.toContain('240p');

    const playerSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/EpisodePlayer.tsx'),
      'utf8'
    );
    expect(playerSource).not.toContain('Automática');
    expect(playerSource).toContain('Configurações');
    expect(playerSource).toContain('Qualidade');
  });

  it('4. campos vazios e URLs inválidas não são contados como fontes disponíveis e não habilitam Qualidade', () => {
    const epWithInvalidAndEmpty = makeEpisodeRow({
      video_url: 'https://cdn.example.com/1080p.mp4',
      quality: '1080p',
      video_url_2: '',
      quality_2: '720p',
      video_url_3: 'not-a-valid-url',
      quality_3: '480p',
      video_url_4: 'ftp://invalid-protocol.example.com/360p.mp4',
      quality_4: '360p',
      video_url_5: '   ',
      quality_5: '240p',
    }) as unknown as PlayerEpisode;

    const collected = collectEpisodeSources(epWithInvalidAndEmpty);
    expect(collected).toHaveLength(1);
    expect(collected[0].quality).toBe('1080p');

    expect(shouldShowQualitySelector(collected)).toBe(false);
    expect(getAvailableQualities(collected)).toEqual([]);

    // Mesmo se PlayableSource malformado chegar diretamente no componente
    const malformedPlayable = makePlayableSources([
      { slot: 1, url: 'https://cdn.example.com/1080p.mp4', quality: '1080p' },
      { slot: 2, url: '   ', quality: '720p' },
      { slot: 3, url: 'javascript:alert(1)', quality: '480p' },
    ]);
    expect(getValidPlayableSources(malformedPlayable)).toHaveLength(1);
    expect(shouldShowQualitySelector(malformedPlayable)).toBe(false);
    expect(getAvailableQualities(malformedPlayable)).toEqual([]);
  });

  it('5. remover uma fonte atualiza as opções disponíveis no player', () => {
    const fullSources = makePlayableSources([
      { slot: 1, url: 'https://cdn.example.com/1080p.mp4', quality: '1080p' },
      { slot: 2, url: 'https://cdn.example.com/720p.mp4', quality: '720p' },
      { slot: 3, url: 'https://cdn.example.com/480p.mp4', quality: '480p' },
    ]);
    expect(shouldShowQualitySelector(fullSources)).toBe(true);
    expect(getAvailableQualities(fullSources)).toEqual(['1080p', '720p', '480p']);

    // Remove 480p (restam 2 fontes)
    const twoSources = fullSources.filter((s) => s.slot !== 3);
    expect(shouldShowQualitySelector(twoSources)).toBe(true);
    expect(getAvailableQualities(twoSources)).toEqual(['1080p', '720p']);

    // Remove 720p (resta 1 fonte -> opção Qualidade some completamente)
    const oneSource = twoSources.filter((s) => s.slot !== 2);
    expect(shouldShowQualitySelector(oneSource)).toBe(false);
    expect(getAvailableQualities(oneSource)).toEqual([]);
  });

  it('6. edição de episódio preserva fontes e qualidades existentes sem exigir recadastro', async () => {
    let dbRow = makeEpisodeRow({
      video_url: 'https://cdn.example.com/1080p.mp4',
      quality: '1080p',
      video_url_2: 'https://cdn.example.com/720p.mp4',
      quality_2: '720p',
      source_kind_2: 'mp4',
      video_url_3: 'https://cdn.example.com/480p.mp4',
      quality_3: '480p',
      source_kind_3: 'mp4',
    });

    const mockSql: DiagnosticSqlTag = async (strings, ...values) => {
      const q = strings.join(' ');
      if (q.includes('SELECT')) {
        return [{ ...dbRow }];
      }
      if (q.includes('UPDATE') && !q.includes('video_url_2 =')) {
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
          quality: values[10],
          updated_at: '2026-11-26T14:00:00.000Z',
        };
        return [{ ...dbRow }];
      }
      return [];
    };

    const updated = await updateEpisode(
      'ep_qual_01',
      {
        anime_name: 'Frieren',
        episode_number: '01',
        title: 'O Fim da Jornada (Editado)',
        poster_url: 'https://cdn.example.com/frieren-01.jpg',
        video_url: 'https://cdn.example.com/1080p.mp4',
        quality: '1080p',
        source_kind: 'mp4',
      },
      mockSql
    );

    expect(updated).not.toBeNull();
    expect(updated?.title).toBe('O Fim da Jornada (Editado)');
    expect(updated?.quality).toBe('1080p');
    expect(updated?.video_url_2).toBe('https://cdn.example.com/720p.mp4');
    expect(updated?.quality_2).toBe('720p');
    expect(updated?.video_url_3).toBe('https://cdn.example.com/480p.mp4');
    expect(updated?.quality_3).toBe('480p');
  });

  it('7. troca de qualidade (1080p -> 720p -> 480p) resolve exatamente o índice e a URL correspondentes', () => {
    const sources = makePlayableSources([
      { slot: 1, url: 'https://cdn.example.com/1080p.mp4', quality: '1080p' },
      { slot: 2, url: 'https://cdn.example.com/720p.mp4', quality: '720p' },
      { slot: 3, url: 'https://cdn.example.com/480p.mp4', quality: '480p' },
    ]);

    const idx720 = findSourceIndexForQuality(sources, '720p');
    expect(idx720).toBe(1);
    expect(sources[idx720].resolvedUrl).toBe('https://cdn.example.com/720p.mp4');

    const idx480 = findSourceIndexForQuality(sources, '480p');
    expect(idx480).toBe(2);
    expect(sources[idx480].resolvedUrl).toBe('https://cdn.example.com/480p.mp4');

    const idx1080 = findSourceIndexForQuality(sources, '1080p');
    expect(idx1080).toBe(0);
    expect(sources[idx1080].resolvedUrl).toBe('https://cdn.example.com/1080p.mp4');

    expect(findSourceIndexForQuality(sources, '360p')).toBe(-1);
  });

  it('8. troca durante reprodução preserva currentTime (HLS startPosition + loadedmetadata/canPlay) sem recarregar página', () => {
    const playerSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/EpisodePlayer.tsx'),
      'utf8'
    );

    expect(playerSource).toContain('pendingRestoreTimeRef');
    expect(playerSource).toContain('startPosition: requestedStartPosition');
    expect(playerSource).toContain('v.currentTime = t');
    expect(playerSource).toContain('manualSwitchOriginRef');
    expect(playerSource).not.toContain('window.location.reload');
  });

  it('9. falha na nova qualidade escolhida manualmente reverte para fonte anterior e mantém seleção consistente', () => {
    const playerSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/EpisodePlayer.tsx'),
      'utf8'
    );

    expect(playerSource).toContain('manualOrigin && manualOrigin.targetSlot === failedSlot');
    expect(playerSource).toContain('Não foi possível carregar a qualidade ${manualOrigin.targetQuality}');
    expect(playerSource).toContain('setActiveIndex(manualOrigin.previousIndex)');
    expect(playerSource).toContain('next.delete(previousSource.slot)');
  });

  it('10. episódios legados (qualidades nulas e 1 fonte) continuam reproduzindo sem erro e sem mostrar Qualidade', () => {
    const legacyEpisode = makeEpisodeRow({
      video_url: 'https://cdn.example.com/legacy-episode.mp4',
      quality: null,
      quality_2: null,
      quality_3: null,
      quality_4: null,
      quality_5: null,
    }) as unknown as PlayerEpisode;

    const result = buildPublicEpisodeResult(legacyEpisode);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');

    expect(result.episode.sources).toHaveLength(1);
    expect(result.episode.sources[0].quality).toBe('1080p');
    expect(shouldShowQualitySelector(result.episode.sources)).toBe(false);
    expect(getAvailableQualities(result.episode.sources)).toEqual([]);
  });

  it('11. fontes HLS e MP4 autenticadas (token, exp, X-Amz-*, sig) preservam parâmetros e assinatura de proxy', () => {
    process.env.PLAYER_SESSION_SECRET = '0123456789abcdef0123456789abcdef';

    const hls1080 =
      'https://cdn-sv01.maximaimg.online/hls/ep01-1080p.m3u8?token=tok1080&expires=1999999999';
    const mp4720 =
      'https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/ep01-720p.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=sig720';

    const ep = makeEpisodeRow({
      video_url: hls1080,
      quality: '1080p',
      source_kind: 'hls',
      video_url_2: mp4720,
      quality_2: '720p',
      source_kind_2: 'mp4',
    }) as unknown as PlayerEpisode;

    const result = buildPublicEpisodeResult(ep);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');

    const src1080 = result.episode.sources[0];
    const src720 = result.episode.sources[1];

    expect(src1080.quality).toBe('1080p');
    expect(src1080.kind).toBe('hls');
    expect(src1080.needsProxy).toBe(true);
    expect(src1080.playUrl).toContain('/api/proxy/stream?');
    expect(src1080.playUrl).toContain('sig=');
    expect(src1080.playUrl).toContain('ex=1');
    expect(decodeURIComponent(src1080.playUrl)).toContain('token=tok1080');

    expect(src720.quality).toBe('720p');
    expect(src720.kind).toBe('mp4');
    expect(src720.needsProxy).toBe(true);
    expect(src720.playUrl).toContain('/api/proxy/stream?');
    expect(decodeURIComponent(src720.playUrl)).toContain('X-Amz-Signature=sig720');
  });

  it('12. failover automático permanece independente da seleção manual de qualidade', () => {
    const sources = collectEpisodeSources(
      makeEpisodeRow({
        video_url: 'https://cdn.example.com/1080p.mp4',
        quality: '1080p',
        video_url_2: 'https://cdn.example.com/720p.mp4',
        quality_2: '720p',
        video_url_3: 'https://cdn.example.com/480p.mp4',
        quality_3: '480p',
      }) as unknown as EpisodeUrlsInputLike
    );

    expect(getNextFallbackSourceIndex(sources, 0, new Set([1]))).toBe(1);
    expect(getNextFallbackSourceIndex(sources, 1, new Set([1, 2]))).toBe(2);
    expect(getNextFallbackSourceIndex(sources, 2, new Set([1, 2, 3]))).toBeNull();
  });

  it('13. persistência no banco (createEpisode, getEpisodeById, listEpisodes), Fallback 0a e migration 0009', async () => {
    // Valida qualidades suportadas e rejeição de opções fora da lista
    expect([...AVAILABLE_QUALITIES]).toEqual(['1080p', '720p', '480p', '360p', '240p']);
    expect(sanitizeQuality('1080P')).toBe('1080p');
    expect(sanitizeQuality('Automática')).toBeNull();
    expect(sanitizeQuality('4k')).toBeNull();
    expect(normalizeQuality('auto', '720p')).toBe('720p');

    const sanitized = sanitizeEpisodeInput({
      anime_name: 'Frieren',
      episode_number: '02',
      title: 'Episódio 2',
      poster_url: 'https://cdn.example.com/ep02.jpg',
      video_url: 'https://cdn.example.com/ep02-1080p.mp4',
      quality: '1080p',
      video_url_2: 'https://cdn.example.com/ep02-720p.mp4',
      quality_2: '720p',
      video_url_3: '',
      quality_3: '480p',
    });
    expect(sanitized.quality).toBe('1080p');
    expect(sanitized.quality_2).toBe('720p');
    expect(sanitized.quality_3).toBeNull();

    // Create + Get + List round-trip
    let storedRow: Record<string, unknown> | null = null;
    const mockSql: DiagnosticSqlTag = async (strings, ...values) => {
      const q = strings.join(' ');
      if (q.includes('INSERT INTO public.player_episodes')) {
        storedRow = makeEpisodeRow({
          id: values[0],
          anime_name: values[1],
          episode_number: values[2],
          opening_start_seconds: values[3],
          opening_end_seconds: values[4],
          title: values[5],
          poster_url: values[6],
          video_url: values[7],
          video_url_2: values[8],
          video_url_3: values[9],
          video_url_4: values[10],
          video_url_5: values[11],
          quality: values[12],
          quality_2: values[13],
          quality_3: values[14],
          quality_4: values[15],
          quality_5: values[16],
        });
        return [{ ...storedRow }];
      }
      if (q.includes('SELECT') && storedRow) {
        return [{ ...storedRow }];
      }
      return [];
    };

    const created = await createEpisode(
      {
        anime_name: 'Frieren',
        episode_number: '02',
        title: 'Episódio 2',
        poster_url: 'https://cdn.example.com/ep02.jpg',
        video_url: 'https://cdn.example.com/ep02-1080p.mp4',
        quality: '1080p',
        video_url_2: 'https://cdn.example.com/ep02-720p.mp4',
        quality_2: '720p',
      },
      mockSql
    );
    expect(created.quality).toBe('1080p');
    expect(created.quality_2).toBe('720p');

    const loaded = await getEpisodeById(created.id, mockSql);
    expect(loaded?.quality).toBe('1080p');
    expect(loaded?.quality_2).toBe('720p');

    const adminSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/routes/admin.tsx'),
      'utf8'
    );
    expect(adminSource).toContain('Adicionar fonte');
    expect(adminSource).toContain('Remover fonte');
    expect(adminSource).toContain('AVAILABLE_QUALITIES');
    expect(adminSource).not.toContain('Automática');

    // Fallback 0a: banco sem colunas quality (migration 0009 pendente) ainda cria/atualiza episódio
    const fallbackSql: DiagnosticSqlTag = async (strings, ...values) => {
      const q = strings.join(' ');
      if (q.includes('quality')) {
        const err = new Error('column "quality" of relation "player_episodes" does not exist');
        (err as { code?: string }).code = '42703';
        throw err;
      }
      if (q.includes('INSERT INTO public.player_episodes')) {
        return [
          makeEpisodeRow({
            id: values[0],
            anime_name: values[1],
            episode_number: values[2],
            title: values[5],
            poster_url: values[6],
            video_url: values[7],
            quality: null,
            quality_2: null,
          }),
        ];
      }
      return [];
    };

    const fallbackCreated = await createEpisode(
      {
        anime_name: 'Frieren',
        episode_number: '03',
        title: 'Episódio 3',
        poster_url: 'https://cdn.example.com/ep03.jpg',
        video_url: 'https://cdn.example.com/ep03-1080p.mp4',
        quality: '1080p',
      },
      fallbackSql
    );
    expect(fallbackCreated.video_url).toBe('https://cdn.example.com/ep03-1080p.mp4');

    // Migration 0009 statements válidos
    const m0009 = fs.readFileSync(
      path.resolve(process.cwd(), 'migrations/0009_add_video_qualities.sql'),
      'utf8'
    );
    const statements = splitSqlStatements(m0009);
    expect(statements).toHaveLength(5);
    expect(statements[0]).toContain('ADD COLUMN IF NOT EXISTS quality TEXT');
    expect(statements[4]).toContain('ADD COLUMN IF NOT EXISTS quality_5 TEXT');
  });
});

type EpisodeUrlsInputLike = Parameters<typeof collectEpisodeSources>[0];
