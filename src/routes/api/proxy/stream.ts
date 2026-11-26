import { createFileRoute } from '@tanstack/react-router';
import { handleProxyStreamRequest } from '@/lib/stream-proxy';

export const Route = createFileRoute('/api/proxy/stream')({
  server: {
    handlers: {
      GET: async ({ request }) => handleProxyStreamRequest(request),
      HEAD: async ({ request }) => handleProxyStreamRequest(request),
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': 'Range, Accept, Content-Type',
            'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range',
            'Access-Control-Max-Age': '86400',
          },
        }),
    },
  },
});
