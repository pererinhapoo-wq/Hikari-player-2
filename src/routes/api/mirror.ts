import { createFileRoute } from '@tanstack/react-router';
import { handleMirrorRequest } from '@/lib/mirror';

export const Route = createFileRoute('/api/mirror')({
  server: {
    handlers: {
      POST: async ({ request }) => handleMirrorRequest(request),
    },
  },
});
