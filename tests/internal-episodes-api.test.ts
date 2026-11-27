import { describe, it, expect, vi } from 'vitest';
import { handleInternalEpisodeLookup } from '@/lib/internal-api';
import * as dbModule from '@/lib/db';

describe('API Interna de Consulta de Episódios (/api/internal/episodes/:id)', () => {
  it('1. rejeita requisições sem o cabeçalho Authorization ou sem prefixo Bearer com 401', async () => {
    const reqNoHeader = new Request('https://app.test/api/internal/episodes/ep123');
    const res1 = await handleInternalEpisodeLookup(reqNoHeader, 'ep123');
    expect(res1.status).toBe(401);
    const body1 = await res1.json();
    expect(body1.error).toBeTruthy();

    const reqBadPrefix = new Request('https://app.test/api/internal/episodes/ep123', {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    const res2 = await handleInternalEpisodeLookup(reqBadPrefix, 'ep123');
    expect(res2.status).toBe(401);
  });

  it('2. rejeita token incorreto ou ausência da variável HIKARI_PLAYER_API_TOKEN com 403', async () => {
    const prevToken = process.env.HIKARI_PLAYER_API_TOKEN;
    process.env.HIKARI_PLAYER_API_TOKEN = 'secret-token-123';

    try {
      const reqWrongToken = new Request('https://app.test/api/internal/episodes/ep123', {
        headers: { Authorization: 'Bearer wrong-token' },
      });
      const res1 = await handleInternalEpisodeLookup(reqWrongToken, 'ep123');
      expect(res1.status).toBe(403);

      // Sem variável de ambiente
      delete process.env.HIKARI_PLAYER_API_TOKEN;
      const reqAnyToken = new Request('https://app.test/api/internal/episodes/ep123', {
        headers: { Authorization: 'Bearer secret-token-123' },
      });
      const res2 = await handleInternalEpisodeLookup(reqAnyToken, 'ep123');
      expect(res2.status).toBe(403);
    } finally {
      process.env.HIKARI_PLAYER_API_TOKEN = prevToken;
    }
  });

  it('3. rejeita formato de ID inválido com 400', async () => {
    const prevToken = process.env.HIKARI_PLAYER_API_TOKEN;
    process.env.HIKARI_PLAYER_API_TOKEN = 'secret-token-123';

    try {
      const req = new Request('https://app.test/api/internal/episodes/bad id with spaces', {
        headers: { Authorization: 'Bearer secret-token-123' },
      });
      const res = await handleInternalEpisodeLookup(req, 'bad id with spaces');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('ID');
    } finally {
      process.env.HIKARI_PLAYER_API_TOKEN = prevToken;
    }
  });

  it('4. retorna 404 quando o episódio não existe no banco', async () => {
    const prevToken = process.env.HIKARI_PLAYER_API_TOKEN;
    process.env.HIKARI_PLAYER_API_TOKEN = 'secret-token-123';

    const getEpisodeSpy = vi.spyOn(dbModule, 'getEpisodeById').mockResolvedValueOnce(null);

    try {
      const req = new Request('https://app.test/api/internal/episodes/nonexistent', {
        headers: { Authorization: 'Bearer secret-token-123' },
      });
      const res = await handleInternalEpisodeLookup(req, 'nonexistent');
      expect(res.status).toBe(404);
      expect(getEpisodeSpy).toHaveBeenCalledWith('nonexistent');
    } finally {
      getEpisodeSpy.mockRestore();
      process.env.HIKARI_PLAYER_API_TOKEN = prevToken;
    }
  });

  it('5. retorna 200 com id e poster_url de um episódio existente, sem expor URLs de vídeo ou dados privados', async () => {
    const prevToken = process.env.HIKARI_PLAYER_API_TOKEN;
    process.env.HIKARI_PLAYER_API_TOKEN = 'secret-token-123';

    const mockEpisode = {
      id: 'ep_test_01',
      anime_name: 'Anime Test',
      episode_number: '01',
      title: 'Episode One',
      poster_url: 'https://cdn.example.com/poster.jpg',
      video_url: 'https://cdn.example.com/video.mp4',
      video_url_2: 'https://allappinc.com/embed/1',
      source_kind: 'mp4',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const getEpisodeSpy = vi
      .spyOn(dbModule, 'getEpisodeById')
      .mockResolvedValueOnce(mockEpisode as any);

    try {
      const req = new Request('https://app.test/api/internal/episodes/ep_test_01', {
        headers: { Authorization: 'Bearer secret-token-123' },
      });
      const res = await handleInternalEpisodeLookup(req, 'ep_test_01');

      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('no-store');

      const body = await res.json();
      expect(body).toEqual({
        id: 'ep_test_01',
        poster_url: 'https://cdn.example.com/poster.jpg',
      });

      // Confirmação rigorosa de ausência de URLs de vídeo ou dados internos
      expect(body.video_url).toBeUndefined();
      expect(body.video_url_2).toBeUndefined();
      expect(body.anime_name).toBeUndefined();
      expect(body.episode_number).toBeUndefined();
      expect(body.title).toBeUndefined();
    } finally {
      getEpisodeSpy.mockRestore();
      process.env.HIKARI_PLAYER_API_TOKEN = prevToken;
    }
  });

  it('6. retorna poster_url como null quando o episódio não possui poster_url', async () => {
    const prevToken = process.env.HIKARI_PLAYER_API_TOKEN;
    process.env.HIKARI_PLAYER_API_TOKEN = 'secret-token-123';

    const mockEpisode = {
      id: 'ep_test_02',
      title: 'No Poster Episode',
      poster_url: null,
      video_url: 'https://cdn.example.com/video.mp4',
    };

    const getEpisodeSpy = vi
      .spyOn(dbModule, 'getEpisodeById')
      .mockResolvedValueOnce(mockEpisode as any);

    try {
      const req = new Request('https://app.test/api/internal/episodes/ep_test_02', {
        headers: { Authorization: 'Bearer secret-token-123' },
      });
      const res = await handleInternalEpisodeLookup(req, 'ep_test_02');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        id: 'ep_test_02',
        poster_url: null,
      });
    } finally {
      getEpisodeSpy.mockRestore();
      process.env.HIKARI_PLAYER_API_TOKEN = prevToken;
    }
  });

  it('7. retorna 500 em caso de erro interno de banco de dados', async () => {
    const prevToken = process.env.HIKARI_PLAYER_API_TOKEN;
    process.env.HIKARI_PLAYER_API_TOKEN = 'secret-token-123';

    const getEpisodeSpy = vi
      .spyOn(dbModule, 'getEpisodeById')
      .mockRejectedValueOnce(new Error('Database connection failed'));

    try {
      const req = new Request('https://app.test/api/internal/episodes/ep_error', {
        headers: { Authorization: 'Bearer secret-token-123' },
      });
      const res = await handleInternalEpisodeLookup(req, 'ep_error');

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBeTruthy();
      expect(JSON.stringify(body)).not.toContain('Database connection failed');
    } finally {
      getEpisodeSpy.mockRestore();
      process.env.HIKARI_PLAYER_API_TOKEN = prevToken;
    }
  });
});
