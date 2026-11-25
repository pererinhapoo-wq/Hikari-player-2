import { createFileRoute } from '@tanstack/react-router';
import { handleThumbnailUploadRequest } from '@/lib/thumbnails';

export const Route = createFileRoute('/api/thumbnails')({
  server: {
    handlers: {
      POST: async ({ request }) => handleThumbnailUploadRequest(request),
    },
  },
});
