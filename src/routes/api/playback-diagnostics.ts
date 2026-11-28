import { createFileRoute } from '@tanstack/react-router';
import { recordDiagnosticEventsBatch } from '@/lib/playback-diagnostics-store';

const MAX_BODY_BYTES = 16_384;

export async function handlePlaybackDiagnosticsPost(request: Request): Promise<Response> {
  try {
    const contentLength = Number(request.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return new Response(JSON.stringify({ ok: false, error: 'Payload muito grande.' }), {
        status: 413,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }

    const rawBody = await request.text();
    if (!rawBody || rawBody.length > MAX_BODY_BYTES) {
      return new Response(JSON.stringify({ ok: false, error: 'Payload inválido.' }), {
        status: rawBody.length > MAX_BODY_BYTES ? 413 : 400,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }

    const parsed = JSON.parse(rawBody) as { events?: unknown };
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.events)) {
      return new Response(JSON.stringify({ ok: false, error: 'Formato inválido.' }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }

    const result = recordDiagnosticEventsBatch(parsed.events);
    return new Response(JSON.stringify({ ok: true, accepted: result.accepted }), {
      status: 202,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'JSON inválido.' }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }
}

export const Route = createFileRoute('/api/playback-diagnostics')({
  server: {
    handlers: {
      POST: async ({ request }) => handlePlaybackDiagnosticsPost(request),
    },
  },
});
