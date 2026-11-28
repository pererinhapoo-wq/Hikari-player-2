import {
  createServerEntry,
  createStartHandler,
  defaultStreamHandler,
  handleStartError,
} from '@tanstack/react-start/server';
import {
  applySecurityHeaders,
  generateCspNonce,
  runWithCspNonce,
  shouldGenerateDocumentNonce,
} from '@/lib/security-headers';

const baseHandler = createStartHandler(defaultStreamHandler);

export default createServerEntry({
  async fetch(request, requestOpts) {
    const nonce = shouldGenerateDocumentNonce(request) ? generateCspNonce() : undefined;

    let response: Response;
    try {
      response = await runWithCspNonce(nonce, () => baseHandler(request, requestOpts));
    } catch (error) {
      response = handleStartError(error);
    }

    return applySecurityHeaders(request, response, { nonce });
  },
});
