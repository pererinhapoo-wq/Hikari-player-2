import { createFileRoute } from '@tanstack/react-router';
import { handleProxyStreamRequest } from '@/lib/stream-proxy';

export const Route = createFileRoute('/api/proxy/stream')({
  server: {
    handlers: {
      GET: async ({ request }) => handleProxyStreamRequest(request),
    },
  },
});
