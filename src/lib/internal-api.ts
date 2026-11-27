import crypto from 'node:crypto';
import { getEpisodeById } from '@/lib/db';

export function safeCompare(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
      return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

export async function handleInternalEpisodeLookup(
  request: Request,
  episodeId: string
): Promise<Response> {
  try {
    const authHeader =
      request.headers.get('Authorization') ?? request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return Response.json(
        { error: 'Unauthorized: missing or invalid Authorization header' },
        { status: 401 }
      );
    }

    const token = authHeader.slice(7).trim();
    const expectedToken = process.env.HIKARI_PLAYER_API_TOKEN?.trim();

    if (!expectedToken || !safeCompare(token, expectedToken)) {
      return Response.json(
        { error: 'Forbidden: invalid token' },
        { status: 403 }
      );
    }

    const id = typeof episodeId === 'string' ? episodeId.trim() : '';
    if (!id || id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id)) {
      return Response.json(
        { error: 'Invalid episode ID format' },
        { status: 400 }
      );
    }

    const episode = await getEpisodeById(id);
    if (!episode) {
      return Response.json(
        { error: 'Episode not found' },
        { status: 404 }
      );
    }

    const responsePayload = {
      id: episode.id,
      poster_url: episode.poster_url ?? null,
    };

    return Response.json(responsePayload, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    console.error('[Internal Episodes API Error]', err);
    return Response.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
