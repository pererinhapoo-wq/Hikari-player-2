import { createFileRoute } from '@tanstack/react-router';
import { handleEmbedRequest } from '@/lib/embed-proxy';

export const Route = createFileRoute('/api/embed')({
  server: {
    handlers: {
      GET: async ({ request }) => handleEmbedRequest(request),
      OPTIONS: async ({ request }) => handleEmbedRequest(request),
    },
  },
});
