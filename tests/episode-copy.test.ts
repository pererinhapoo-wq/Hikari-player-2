import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  COPY_CLIPBOARD_ERROR_MESSAGE,
  COPY_ID_SUCCESS_MESSAGE,
  COPY_POSTER_MISSING_MESSAGE,
  COPY_POSTER_SUCCESS_MESSAGE,
  copyEpisodeField,
  createEpisodeCopyKey,
  getEpisodeCopyId,
  getEpisodeCopyPosterUrl,
} from '@/lib/episode-copy';
import type { EpisodeDto } from '@/lib/types';

function makeEpisode(overrides: Partial<EpisodeDto> = {}): EpisodeDto {
  return {
    id: 'V1StGXR8_Z5jdHi6B-myT',
    anime_name: 'Frieren',
    episode_number: '01',
    opening_start_seconds: null,
    opening_end_seconds: null,
    title: 'O Fim da Jornada',
    poster_url: 'https://cdn.example.com/posters/frieren-01.jpg?v=2',
    video_url: 'https://cdn.example.com/videos/frieren-01.m3u8',
    video_url_2: null,
    video_url_3: null,
    video_url_4: null,
    video_url_5: null,
    source_kind: 'hls',
    source_kind_2: null,
    source_kind_3: null,
    source_kind_4: null,
    source_kind_5: null,
    public_url: 'https://hikari-player-2.vercel.app/e/V1StGXR8_Z5jdHi6B-myT',
    created_at: '2026-11-20T10:00:00.000Z',
    updated_at: '2026-11-20T10:00:00.000Z',
    ...overrides,
  };
}

describe('Ações de copiar ID e link da imagem do episódio', () => {
  it('1. "Copiar ID" copia exatamente o ID real do episódio (inclusive em episódios dublados/duplicados)', async () => {
    const original = makeEpisode({
      id: 'orig_ep_12345',
      public_url: 'https://hikari.example.com/e/orig_ep_12345',
    });
    const dubbedDuplicate = makeEpisode({
      id: 'dub_ep_98765',
      title: 'O Fim da Jornada Dublado',
      public_url: 'https://hikari.example.com/e/dub_ep_98765',
      poster_url: original.poster_url,
    });

    const copiedValues: string[] = [];
    const writeText = vi.fn(async (value: string) => {
      copiedValues.push(value);
    });

    const resOriginal = await copyEpisodeField(original, 'id', { writeText });
    const resDubbed = await copyEpisodeField(dubbedDuplicate, 'id', { writeText });

    expect(resOriginal).toEqual({
      ok: true,
      episodeId: 'orig_ep_12345',
      field: 'id',
      value: 'orig_ep_12345',
      status: 'copied',
      message: COPY_ID_SUCCESS_MESSAGE,
    });
    expect(resDubbed).toEqual({
      ok: true,
      episodeId: 'dub_ep_98765',
      field: 'id',
      value: 'dub_ep_98765',
      status: 'copied',
      message: COPY_ID_SUCCESS_MESSAGE,
    });
    expect(copiedValues).toEqual(['orig_ep_12345', 'dub_ep_98765']);
  });

  it('2. "Copiar link da imagem" copia exatamente o campo poster_url cadastrado sem alterações', async () => {
    const posterUrl =
      'https://my-blob.public.blob.vercel-storage.com/thumbnails/frieren-01-abc.jpg?token=keep';
    const ep = makeEpisode({ poster_url: posterUrl });

    const writeText = vi.fn(async () => undefined);
    const res = await copyEpisodeField(ep, 'poster', { writeText });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(posterUrl);
    expect(res).toEqual({
      ok: true,
      episodeId: ep.id,
      field: 'poster',
      value: posterUrl,
      status: 'copied',
      message: COPY_POSTER_SUCCESS_MESSAGE,
    });
    expect(getEpisodeCopyPosterUrl(ep)).toBe(posterUrl);
  });

  it('3. nunca copia a URL do episódio (/e/{episodeId} ou public_url) no lugar do ID ou da imagem', async () => {
    const ep = makeEpisode({
      id: 'ep_only_id_77',
      public_url: 'https://hikari-player-2.vercel.app/e/ep_only_id_77',
      poster_url: '',
    });

    const writeText = vi.fn(async () => undefined);
    const idRes = await copyEpisodeField(ep, 'id', { writeText });
    const posterRes = await copyEpisodeField(ep, 'poster', { writeText });

    expect(idRes.ok).toBe(true);
    if (idRes.ok) {
      expect(idRes.value).toBe('ep_only_id_77');
      expect(idRes.value).not.toContain('/e/');
      expect(idRes.value).not.toContain('http');
    }

    expect(posterRes.ok).toBe(false);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('ep_only_id_77');
    expect(getEpisodeCopyId(ep)).toBe('ep_only_id_77');
  });

  it('4. episódios sem thumbnail (ou com URL temporária blob:/data:) informam discretamente sem copiar conteúdo incorreto', async () => {
    const writeText = vi.fn(async () => undefined);

    const noPosterCases = [
      makeEpisode({ poster_url: '' }),
      makeEpisode({ poster_url: '   ' }),
      makeEpisode({ poster_url: 'blob:https://hikari.example.com/temp-preview-123' }),
      makeEpisode({ poster_url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' }),
      { id: 'ep_null_poster', poster_url: null },
    ];

    for (const candidate of noPosterCases) {
      const outcome = await copyEpisodeField(candidate, 'poster', { writeText });
      expect(outcome).toEqual({
        ok: false,
        episodeId: getEpisodeCopyId(candidate) ?? '',
        field: 'poster',
        status: 'missing_poster',
        message: COPY_POSTER_MISSING_MESSAGE,
      });
    }

    expect(writeText).not.toHaveBeenCalled();
  });

  it('5. estados de confirmação e erro na área de transferência funcionam corretamente', async () => {
    const ep = makeEpisode();

    const failingWriteText = vi.fn(async () => {
      throw new Error('Clipboard permission denied');
    });

    const idError = await copyEpisodeField(ep, 'id', {
      writeText: failingWriteText,
      execCopyFallback: () => false,
    });
    expect(idError).toEqual({
      ok: false,
      episodeId: ep.id,
      field: 'id',
      status: 'clipboard_error',
      message: COPY_CLIPBOARD_ERROR_MESSAGE,
    });

    const posterError = await copyEpisodeField(ep, 'poster', {
      writeText: failingWriteText,
      execCopyFallback: () => false,
    });
    expect(posterError).toEqual({
      ok: false,
      episodeId: ep.id,
      field: 'poster',
      status: 'clipboard_error',
      message: COPY_CLIPBOARD_ERROR_MESSAGE,
    });

    // Quando o fallback execCopyFallback funciona, confirma normalmente
    const fallbackRecovered = await copyEpisodeField(ep, 'id', {
      writeText: failingWriteText,
      execCopyFallback: () => true,
    });
    expect(fallbackRecovered).toEqual({
      ok: true,
      episodeId: ep.id,
      field: 'id',
      value: ep.id,
      status: 'copied',
      message: COPY_ID_SUCCESS_MESSAGE,
    });
  });

  it('6. as duas ações operam independentemente e substituem "Copiar link" nos cards da biblioteca em src/routes/admin.tsx', async () => {
    const epA = makeEpisode({
      id: 'ep_A',
      poster_url: 'https://cdn.example.com/a.jpg',
    });
    const epB = makeEpisode({
      id: 'ep_B',
      poster_url: '',
    });

    expect(createEpisodeCopyKey(epA.id, 'id')).not.toBe(createEpisodeCopyKey(epA.id, 'poster'));
    expect(createEpisodeCopyKey(epA.id, 'id')).not.toBe(createEpisodeCopyKey(epB.id, 'id'));

    const writes: string[] = [];
    const writeText = vi.fn(async (value: string) => {
      writes.push(value);
    });

    const [resAId, resAPoster, resBPoster] = await Promise.all([
      copyEpisodeField(epA, 'id', { writeText }),
      copyEpisodeField(epA, 'poster', { writeText }),
      copyEpisodeField(epB, 'poster', { writeText }),
    ]);

    expect(resAId.ok).toBe(true);
    expect(resAPoster.ok).toBe(true);
    expect(resBPoster.ok).toBe(false);
    expect(writes).toEqual(['ep_A', 'https://cdn.example.com/a.jpg']);

    const adminSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/routes/admin.tsx'),
      'utf8'
    );

    // Ação antiga da listagem foi substituída pelas duas ações independentes
    expect(adminSource).not.toContain('aria-label={`Copiar link de ${epLabel}`}');
    expect(adminSource).toContain('aria-label={`Copiar ID de ${epLabel}`}');
    expect(adminSource).toContain('aria-label={`Copiar link da imagem de ${epLabel}`}');
    expect(adminSource).toContain("handleCopyEpisodeField(ep, 'id')");
    expect(adminSource).toContain("handleCopyEpisodeField(ep, 'poster')");
    expect(adminSource).toContain('<Hash');
    expect(adminSource).toContain('<ImageIcon');
    expect(adminSource).toContain('Copiar ID');
    expect(adminSource).toContain('Copiar link da imagem');
    // Rota /e/{episodeId} preservada no botão Abrir
    expect(adminSource).toContain('href={`/e/${encodeURIComponent(ep.id)}`}');
  });
});
