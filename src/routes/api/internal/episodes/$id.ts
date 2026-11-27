import { createFileRoute } from '@tanstack/react-router';
import { handleInternalEpisodeLookup } from '@/lib/internal-api';

export const Route = createFileRoute('/api/internal/episodes/$id')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        return handleInternalEpisodeLookup(request, params.id);
      },
    },
  },
});
