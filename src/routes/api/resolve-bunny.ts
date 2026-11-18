import { createFileRoute } from '@tanstack/react-router';
import { resolveBunnyStreamSource } from '@/lib/bunny';
import { parseBunnyEmbedUrl, validateHttpUrl } from '@/lib/video-sources';

export const Route = createFileRoute('/api/resolve-bunny')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const reqUrl = new URL(request.url);
        const rawTarget = reqUrl.searchParams.get('url') ?? '';

        const validation = validateHttpUrl(rawTarget);
        if (!validation.valid || !validation.normalizedUrl) {
          return Response.json(
            { ok: false, error: 'URL Bunny inválida.' },
            { status: 400 }
          );
        }

        const parsed = new URL(validation.normalizedUrl);
        if (!parseBunnyEmbedUrl(parsed)) {
          return Response.json(
            { ok: false, error: 'Apenas URLs player.mediadelivery.net/embed são aceitas.' },
            { status: 400 }
          );
        }

        const resolved = await resolveBunnyStreamSource(validation.normalizedUrl);
        return Response.json(resolved, {
          status: 200,
          headers: { 'Cache-Control': 'no-store' },
        });
      },
    },
  },
});
