export interface CspNonceStore {
  getStore(): string | undefined;
}

export const CSP_NONCE_STORE_SYMBOL = Symbol.for('hikari.cspNonceStore');

export function getCurrentCspNonce(): string | undefined {
  if (typeof window !== 'undefined') {
    return undefined;
  }
  const store = (globalThis as Record<symbol, CspNonceStore | undefined>)[
    CSP_NONCE_STORE_SYMBOL
  ];
  const value = store?.getStore();
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
