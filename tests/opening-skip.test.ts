import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createEpisode,
  type DiagnosticSqlTag,
  sanitizeEpisodeInput,
  updateEpisode,
} from '@/lib/db';
import {
  formatOpeningTimestamp,
  isOpeningSkipVisible,
  parseOpeningRange,
  parseOpeningTimestamp,
  validateOpeningSecondsPair,
} from '@/lib/opening-skip';

describe('Pular abertura — conversão, validação e formatação de horários', () => {
  it('1. aceita MM:SS e HH:MM:SS e converte corretamente para segundos', () => {
    expect(parseOpeningTimestamp('00:00')).toBe(0);
    expect(parseOpeningTimestamp('01:30')).toBe(90);
    expect(parseOpeningTimestamp(' 03:00 ')).toBe(180);
    expect(parseOpeningTimestamp('1:02:05')).toBe(3725);
    expect(parseOpeningTimestamp('01:02:05')).toBe(3725);

    expect(() => parseOpeningTimestamp('')).toThrow(/vazio/i);
    expect(() => parseOpeningTimestamp('01:75')).toThrow(/Formato inválido/i);
    expect(() => parseOpeningTimestamp('90')).toThrow(/Formato inválido/i);
    expect(() => parseOpeningTimestamp('abc')).toThrow(/Formato inválido/i);
  });

  it('2. valida intervalo de opening: permite ambos vazios, exige par completo e impede fim <= início', () => {
    expect(parseOpeningRange('', '')).toEqual({
      opening_start_seconds: null,
      opening_end_seconds: null,
    });
    expect(parseOpeningRange(null, undefined)).toEqual({
      opening_start_seconds: null,
      opening_end_seconds: null,
    });

    expect(parseOpeningRange('01:30', '03:00')).toEqual({
      opening_start_seconds: 90,
      opening_end_seconds: 180,
    });

    expect(() => parseOpeningRange('01:30', '')).toThrow(/tanto o início quanto o fim/i);
    expect(() => parseOpeningRange('', '03:00')).toThrow(/tanto o início quanto o fim/i);
    expect(() => parseOpeningRange('03:00', '03:00')).toThrow(/maior que o início/i);
    expect(() => parseOpeningRange('03:10', '01:30')).toThrow(/maior que o início/i);

    expect(validateOpeningSecondsPair(null, null)).toEqual({
      opening_start_seconds: null,
      opening_end_seconds: null,
    });
    expect(validateOpeningSecondsPair(90, 180)).toEqual({
      opening_start_seconds: 90,
      opening_end_seconds: 180,
    });
    expect(() => validateOpeningSecondsPair(180, 90)).toThrow(/maior que o início/i);
    expect(() => validateOpeningSecondsPair(90, null)).toThrow(/tanto o início quanto o fim/i);
  });

  it('3. formata segundos de volta para MM:SS e HH:MM:SS para edição no admin', () => {
    expect(formatOpeningTimestamp(null)).toBe('');
    expect(formatOpeningTimestamp(undefined)).toBe('');
    expect(formatOpeningTimestamp(0)).toBe('00:00');
    expect(formatOpeningTimestamp(90)).toBe('01:30');
    expect(formatOpeningTimestamp(180)).toBe('03:00');
    expect(formatOpeningTimestamp(3665)).toBe('01:01:05');
  });
});

describe('Pular abertura — visibilidade automática do botão no Player 1', () => {
  it('4. exibe o botão apenas dentro do intervalo [início, fim) e oculta fora dele', () => {
    const base = {
      openingStartSeconds: 90,
      openingEndSeconds: 180,
      hasStarted: true,
      isIframeMode: false,
      fatalError: false,
    };

    // 00:00–01:29 -> oculto
    expect(isOpeningSkipVisible({ ...base, currentTime: 0 })).toBe(false);
    expect(isOpeningSkipVisible({ ...base, currentTime: 89.9 })).toBe(false);

    // 01:30–02:59 -> visível
    expect(isOpeningSkipVisible({ ...base, currentTime: 90 })).toBe(true);
    expect(isOpeningSkipVisible({ ...base, currentTime: 125.4 })).toBe(true);
    expect(isOpeningSkipVisible({ ...base, currentTime: 179.9 })).toBe(true);

    // 03:00 em diante -> oculto
    expect(isOpeningSkipVisible({ ...base, currentTime: 180 })).toBe(false);
    expect(isOpeningSkipVisible({ ...base, currentTime: 240 })).toBe(false);

    // Se usuário voltar manualmente para dentro da opening -> volta a aparecer
    expect(isOpeningSkipVisible({ ...base, currentTime: 110 })).toBe(true);
  });

  it('5. mantém recurso indisponível para iframe, antes do Play, sem opening ou em erro fatal', () => {
    expect(
      isOpeningSkipVisible({
        currentTime: 100,
        openingStartSeconds: 90,
        openingEndSeconds: 180,
        hasStarted: true,
        isIframeMode: true,
        fatalError: false,
      })
    ).toBe(false);

    expect(
      isOpeningSkipVisible({
        currentTime: 100,
        openingStartSeconds: 90,
        openingEndSeconds: 180,
        hasStarted: false,
        isIframeMode: false,
        fatalError: false,
      })
    ).toBe(false);

    expect(
      isOpeningSkipVisible({
        currentTime: 100,
        openingStartSeconds: 90,
        openingEndSeconds: 180,
        hasStarted: true,
        isIframeMode: false,
        fatalError: true,
      })
    ).toBe(false);

    expect(
      isOpeningSkipVisible({
        currentTime: 100,
        openingStartSeconds: null,
        openingEndSeconds: null,
        hasStarted: true,
        isIframeMode: false,
        fatalError: false,
      })
    ).toBe(false);
  });
});

describe('Pular abertura — persistência no banco e integração Player / Admin', () => {
  it('6. sanitizeEpisodeInput, createEpisode e updateEpisode persistem opening_start_seconds e opening_end_seconds preservando episódios antigos', async () => {
    const sanitized = sanitizeEpisodeInput({
      anime_name: 'Jujutsu Kaisen',
      episode_number: '01',
      opening_start_seconds: 90,
      opening_end_seconds: 180,
      title: 'Ryomen Sukuna',
      poster_url: 'https://cdn.example.com/jjk1.jpg',
      video_url: 'https://cdn.example.com/jjk1.m3u8',
      source_kind: 'hls',
    });

    expect(sanitized.opening_start_seconds).toBe(90);
    expect(sanitized.opening_end_seconds).toBe(180);

    const legacyWithoutOpening = sanitizeEpisodeInput({
      title: 'Episódio Antigo',
      poster_url: 'https://cdn.example.com/old.jpg',
      video_url: 'https://cdn.example.com/old.mp4',
    });
    expect(legacyWithoutOpening.opening_start_seconds).toBeNull();
    expect(legacyWithoutOpening.opening_end_seconds).toBeNull();

    let createdValues: unknown[] = [];
    const createMockSql: DiagnosticSqlTag = async (_strings, ...values) => {
      createdValues = values;
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
          source_kind: 'hls',
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
        anime_name: 'Jujutsu Kaisen',
        episode_number: '01',
        opening_start_seconds: 90,
        opening_end_seconds: 180,
        title: 'Ryomen Sukuna',
        poster_url: 'https://cdn.example.com/jjk1.jpg',
        video_url: 'https://cdn.example.com/jjk1.m3u8',
        source_kind: 'hls',
      },
      createMockSql
    );

    expect(createdValues[3]).toBe(90);
    expect(createdValues[4]).toBe(180);
    expect(created.opening_start_seconds).toBe(90);
    expect(created.opening_end_seconds).toBe(180);

    let updateQuery = '';
    let updatedValues: unknown[] = [];
    const updateMockSql: DiagnosticSqlTag = async (strings, ...values) => {
      updateQuery = strings.join(' ');
      updatedValues = values;
      return [
        {
          id: String(values[9]),
          anime_name: values[0],
          episode_number: values[1],
          opening_start_seconds: values[2],
          opening_end_seconds: values[3],
          title: values[4],
          poster_url: values[5],
          video_url: values[6],
          video_url_2: 'https://cdn.example.com/old-p2.mp4',
          video_url_3: null,
          video_url_4: null,
          video_url_5: null,
          source_kind: 'hls',
          source_kind_2: 'mp4',
          source_kind_3: null,
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
      'ep_legacy_keep',
      {
        anime_name: 'Jujutsu Kaisen',
        episode_number: '01',
        opening_start_seconds: 95,
        opening_end_seconds: 185,
        title: 'Ryomen Sukuna',
        poster_url: 'https://cdn.example.com/jjk1.jpg',
        video_url: 'https://cdn.example.com/jjk1.m3u8',
        source_kind: 'hls',
      },
      updateMockSql
    );

    expect(updateQuery).toContain('opening_start_seconds =');
    expect(updateQuery).toContain('opening_end_seconds =');
    expect(updateQuery).not.toContain('video_url_2 =');
    expect(updatedValues[2]).toBe(95);
    expect(updatedValues[3]).toBe(185);
    expect(updated?.opening_start_seconds).toBe(95);
    expect(updated?.opening_end_seconds).toBe(185);
    expect(updated?.video_url_2).toBe('https://cdn.example.com/old-p2.mp4');
  });

  it('7. confirma presença dos campos no Admin, migration aditiva segura e botão animado no Player 1', () => {
    const adminSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/routes/admin.tsx'),
      'utf8'
    );
    const playerSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/EpisodePlayer.tsx'),
      'utf8'
    );
    const migrationSql = fs.readFileSync(
      path.resolve(process.cwd(), 'migrations/0005_add_opening_timestamps.sql'),
      'utf8'
    );

    expect(adminSource).toContain('Início da opening');
    expect(adminSource).toContain('Fim da opening');
    expect(adminSource).toContain('parseOpeningRange');
    expect(adminSource).toContain('formatOpeningTimestamp');
    expect(adminSource).not.toContain('Player 2');

    expect(playerSource).toContain('Pular abertura');
    expect(playerSource).toContain('video.currentTime = targetTime');
    expect(playerSource).toContain('useReducedMotion');
    expect(playerSource).toContain('AnimatePresence');
    expect(playerSource).toContain('#a855f7');

    expect(migrationSql).toContain('ALTER TABLE player_episodes');
    expect(migrationSql).toContain('ADD COLUMN IF NOT EXISTS opening_start_seconds');
    expect(migrationSql).toContain('ADD COLUMN IF NOT EXISTS opening_end_seconds');
    expect(migrationSql.trim().startsWith('--')).toBe(false);
  });
});
