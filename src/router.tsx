import { createRouter } from '@tanstack/react-router';
import { getCurrentCspNonce } from '@/lib/csp-nonce';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  const nonce = getCurrentCspNonce();
  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    ...(nonce ? { ssr: { nonce } } : {}),
  });

  return router;
}
