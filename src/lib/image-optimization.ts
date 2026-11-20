import { validateHttpUrl } from '@/lib/video-sources';

export type ImageUsage = 'capa' | 'miniatura' | 'banner';

export const IMAGE_WIDTH_LIMITS: Record<ImageUsage, number> = {
  capa: 230,
  miniatura: 120,
  banner: 1280,
};

export const IMAGE_DIMENSIONS: Record<ImageUsage, { width: number; height: number }> = {
  capa: { width: 230, height: 129 },
  miniatura: { width: 120, height: 84 },
  banner: { width: 1280, height: 720 },
};

export const MAX_IMAGE_BYTES = 60 * 1024; // 60 KB

const SIGNED_QUERY_KEYS = new Set([
  'x-amz-signature',
  'x-amz-credential',
  'x-goog-signature',
  'signature',
  'sig',
  'token',
  'expires',
  'policy',
  'key-pair-id',
]);

function hasSignedQueryParams(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    if (SIGNED_QUERY_KEYS.has(key.toLowerCase())) {
      return true;
    }
  }
  return false;
}

function mapTmdbWidth(targetWidth: number): string {
  if (targetWidth <= 154) return 'w154';
  if (targetWidth <= 185) return 'w185';
  if (targetWidth <= 300) return 'w300';
  if (targetWidth <= 500) return 'w500';
  if (targetWidth <= 780) return 'w780';
  return 'w1280';
}

export function resizeImageUrlForWidth(rawUrl: string, targetWidth: number): string {
  const check = validateHttpUrl(rawUrl);
  if (!check.valid || !check.normalizedUrl) {
    return rawUrl;
  }

  const clampedWidth = Math.max(1, Math.min(1280, Math.round(targetWidth)));

  try {
    const parsed = new URL(check.normalizedUrl);
    if (hasSignedQueryParams(parsed)) {
      return check.normalizedUrl;
    }

    const host = parsed.hostname.toLowerCase();

    // TMDB (image.tmdb.org/t/p/<size>/...)
    if (host === 'image.tmdb.org' && /^\/t\/p\/(original|w\d+)\//i.test(parsed.pathname)) {
      parsed.pathname = parsed.pathname.replace(
        /^\/t\/p\/(original|w\d+)\//i,
        `/t/p/${mapTmdbWidth(clampedWidth)}/`
      );
      return parsed.toString();
    }

    // WordPress Photon (*.wp.com)
    if (host.endsWith('.wp.com')) {
      parsed.searchParams.set('w', String(clampedWidth));
      if (!parsed.searchParams.has('quality')) {
        parsed.searchParams.set('quality', '75');
      }
      parsed.searchParams.set('strip', 'all');
      return parsed.toString();
    }

    // wsrv.nl / images.weserv.nl
    if (host === 'wsrv.nl' || host === 'images.weserv.nl') {
      parsed.searchParams.set('w', String(clampedWidth));
      parsed.searchParams.set('output', 'webp');
      if (!parsed.searchParams.has('q')) {
        parsed.searchParams.set('q', '75');
      }
      return parsed.toString();
    }

    // Cloudinary (/image/upload/...)
    if (host === 'res.cloudinary.com' && parsed.pathname.includes('/image/upload/')) {
      const marker = '/image/upload/';
      const idx = parsed.pathname.indexOf(marker);
      const after = parsed.pathname.slice(idx + marker.length);
      if (!after.startsWith('w_') && !after.startsWith('c_')) {
        parsed.pathname = `${parsed.pathname.slice(0, idx + marker.length)}w_${clampedWidth},c_limit,f_auto,q_auto/${after}`;
        return parsed.toString();
      }
    }

    return check.normalizedUrl;
  } catch {
    return check.normalizedUrl;
  }
}

export interface OptimizedImageProps {
  src: string;
  srcSet: string;
  width: number;
  height: number;
  loading: 'lazy' | 'eager';
  decoding: 'async';
  draggable: false;
  fetchPriority?: 'high';
}

export function getOptimizedImageProps(
  rawUrl: string,
  usage: ImageUsage,
  options: { isLcp?: boolean } = {}
): OptimizedImageProps {
  const width1x = IMAGE_WIDTH_LIMITS[usage];
  const width2x = Math.min(width1x * 2, IMAGE_WIDTH_LIMITS.banner);
  const src1x = resizeImageUrlForWidth(rawUrl, width1x);
  const src2x = resizeImageUrlForWidth(rawUrl, width2x);
  const dims = IMAGE_DIMENSIONS[usage];
  const isLcp = options.isLcp === true;

  return {
    src: src1x,
    srcSet: `${src1x} 1x, ${src2x} 2x`,
    width: dims.width,
    height: dims.height,
    loading: isLcp ? 'eager' : 'lazy',
    decoding: 'async',
    draggable: false,
    ...(isLcp ? { fetchPriority: 'high' as const } : {}),
  };
}
