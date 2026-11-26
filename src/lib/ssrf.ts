import dns from 'node:dns/promises';
import net from 'node:net';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata',
]);

export const TRUSTED_MEDIA_HOSTS = [
  'maximaimg.online',
  'mywallpaper-4k-image.net',
] as const;

export const ALLOWED_MEDIA_EXTENSIONS = [
  '.m3u8',
  '.m3u',
  '.ts',
  '.m4s',
  '.webp',
  '.mp4',
  '.webm',
  '.key',
  '.aac',
  '.vtt',
] as const;

const DISALLOWED_PROXY_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.php',
  '.asp',
  '.aspx',
  '.jsp',
  '.js',
  '.mjs',
  '.css',
  '.svg',
  '.xml',
  '.exe',
  '.sh',
  '.bat',
  '.cmd',
]);

export function isTrustedMediaHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.+$/, '');
  return TRUSTED_MEDIA_HOSTS.some(
    (allowed) => lower === allowed || lower.endsWith(`.${allowed}`)
  );
}

export function isAllowedProxyMediaUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (
    host === 'public.blob.vercel-storage.com' ||
    host.endsWith('.public.blob.vercel-storage.com')
  ) {
    return true;
  }
  const pathname = url.pathname.toLowerCase();
  for (const ext of ALLOWED_MEDIA_EXTENSIONS) {
    if (pathname.endsWith(ext)) {
      return true;
    }
  }
  const lastSegment = pathname.split('/').pop() ?? '';
  const dotIdx = lastSegment.lastIndexOf('.');
  if (dotIdx > 0) {
    const ext = lastSegment.slice(dotIdx);
    if (DISALLOWED_PROXY_EXTENSIONS.has(ext)) {
      return false;
    }
  }
  return true;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;

  // 0.0.0.0/8 ("this" network)
  if (a === 0) return true;
  // 10.0.0.0/8 (RFC1918)
  if (a === 10) return true;
  // 100.64.0.0/10 (CGNAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (Link-local / Cloud metadata)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (RFC1918)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 & 192.0.2.0/24
  if (a === 192 && b === 0) return true;
  // 192.168.0.0/16 (RFC1918)
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 (Benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 224.0.0.0/4 (Multicast) and >= 240.0.0.0 (Reserved)
  if (a >= 224) return true;

  return false;
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const normalized = ip.trim().toLowerCase();
  const kind = net.isIP(normalized);
  if (kind === 0) return true;
  if (kind === 4) return isPrivateIpv4(normalized);

  // IPv6 checks
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // ULA fc00::/7
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
    return true; // Link-local fe80::/10
  }
  if (normalized.startsWith('ff')) return true; // Multicast
  if (normalized.startsWith('::ffff:')) {
    const v4 = normalized.slice('::ffff:'.length);
    if (net.isIPv4(v4)) {
      return isPrivateIpv4(v4);
    }
    return true;
  }

  return false;
}

export async function assertSafeExternalUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('URL inválida para requisição externa.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Protocolo não permitido.');
  }

  if (parsed.username || parsed.password) {
    throw new Error('Credenciais na URL não são permitidas.');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    !hostname ||
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error('Destino de rede interno bloqueado.');
  }

  if (net.isIP(hostname) !== 0) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new Error('Endereço IP privado ou reservado bloqueado.');
    }
    return parsed;
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('Falha ao resolver DNS do destino externo.');
  }

  if (!records || records.length === 0) {
    throw new Error('Destino sem registros DNS válidos.');
  }

  for (const record of records) {
    if (isPrivateOrReservedIp(record.address)) {
      throw new Error('Destino resolve para endereço IP privado ou reservado.');
    }
  }

  return parsed;
}

export async function assertSafeMediaProxyUrl(rawUrl: string): Promise<URL> {
  const parsed = await assertSafeExternalUrl(rawUrl);
  if (!isAllowedProxyMediaUrl(parsed)) {
    throw new Error('Extensão de destino não permitida no proxy de mídia.');
  }
  return parsed;
}

export interface SafeFetchOptions {
  maxRedirects?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  method?: string;
}

export async function safeFetchWithRedirects(
  initialUrl: string,
  options: SafeFetchOptions = {}
): Promise<{ response: Response; finalUrl: string }> {
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 15000;
  const method = options.method ?? 'GET';
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validatedUrl = await assertSafeExternalUrl(currentUrl);
    const fetchInit: RequestInit = {
      method,
      redirect: 'manual',
      headers: options.headers,
    };

    let response: Response;
    if (timeoutMs > 0) {
      const fetchPromise = fetch(validatedUrl.toString(), fetchInit);
      const timeoutPromise = new Promise<Response>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout na requisição externa.')), timeoutMs)
      );
      response = await Promise.race([fetchPromise, timeoutPromise]);
    } else {
      response = await fetch(validatedUrl.toString(), fetchInit);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error('Redirecionamento sem cabeçalho Location.');
      }
      if (hop === maxRedirects) {
        throw new Error('Número máximo de redirecionamentos excedido.');
      }
      currentUrl = new URL(location, validatedUrl).toString();
      continue;
    }

    return {
      response,
      finalUrl: validatedUrl.toString(),
    };
  }

  throw new Error('Falha ao seguir redirecionamentos.');
}
