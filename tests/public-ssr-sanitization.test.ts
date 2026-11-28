import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlayerEpisode } from '@/lib/db';
import {
  canUseDirectMaximaimgFallback,
  classifyHlsError,
  decideHlsErrorAction,
} from '@/lib/hls-playback';
import { buildSignedProxyPath, verifyProxyReferer, verifyProxySignature } from '@/lib/proxy-signing';
import { buildPublicEpisodeResult } from '@/lib/server-fns';
import type { InternalPlayableSource, PlayableSource } from '@/lib/types';
import {
  getNextFallbackSourceIndex,
  normalizeVideoSource,
  sanitizePlayableSourceForPublic,
} from '@/lib/video-sources';

function makeEpisode(overrides: Partial<PlayerEpisode> = {}): PlayerEpisode {
  return {
    id: 'ep_ssr_test_01',
    anime_name: 'Anime Fictício',
    episode_number: '01',
    opening_start_seconds: 90,
    opening_end_seconds: 180,
    title: 'Episódio Piloto',
    poster_url: 'https://images.example.test/posters/ep01.jpg',
    video_url: 'https://origin.example.test/protected/ep01/master.m3u8',
    video_url_2: null,
    video_url_3: null,
    video_url_4: null,
    video_url_5: null,
    source_kind: null,
    source_kind_2: null,
    source_kind_3: null,
    source_kind_4: null,
    source_kind_5: null,
    force_proxy: null,
    force_proxy_2: null,
    force_proxy_3: null,
    force_proxy_4: null,
    force_proxy_5: null,
    is_mirror: false,
    is_mirror_2: false,
    is_mirror_3: false,
    is_mirror_4: false,
    is_mirror_5: false,
    source_referer: null,
    source_referer_2: null,
    source_referer_3: null,
    source_referer_4: null,
    source_referer_5: null,
    created_at: '2026-11-28T00:00:00.000Z',
    updated_at: '2026-11-28T00:00:00.000Z',
    ...overrides,
  };
}

describe('ALTO-03 — Sanitização de URLs originais no SSR público (/e/$id)', () => {
  const originalSecret = process.env.PLAYER_SESSION_SECRET;
  const originalWorkerBase = process.env.WORKER_BASE;

  beforeEach(() => {
    process.env.PLAYER_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
    delete process.env.WORKER_BASE;
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.PLAYER_SESSION_SECRET;
    } else {
      process.env.PLAYER_SESSION_SECRET = originalSecret;
    }
    if (originalWorkerBase === undefined) {
      delete process.env.WORKER_BASE;
    } else {
      process.env.WORKER_BASE = originalWorkerBase;
    }
  });

  it('1-3. remove rawUrl, resolvedUrl e fallbackIframeUrl do objeto público quando needsProxy === true', () => {
    const internalMuxSource: InternalPlayableSource = {
      slot: 1,
      label: 'Player 1',
      rawUrl: 'https://player.mux.com/FakeMuxPlaybackId01?token=secret-mux-token',
      resolvedUrl: 'https://stream.mux.com/FakeMuxPlaybackId01.m3u8?token=secret-mux-token',
      fallbackIframeUrl: 'https://player.mux.com/FakeMuxPlaybackId01?token=secret-mux-token',
      kind: 'hls',
      provider: 'mux',
      needsProxy: true,
      requiresServerResolve: false,
      formatLabel: 'Mux · HLS',
      playUrl: buildSignedProxyPath(
        'https://stream.mux.com/FakeMuxPlaybackId01.m3u8?token=secret-mux-token'
      ),
    };

    const sanitized = sanitizePlayableSourceForPublic(internalMuxSource);

    expect(sanitized.needsProxy).toBe(true);
    expect('rawUrl' in sanitized).toBe(false);
    expect('resolvedUrl' in sanitized).toBe(false);
    expect('fallbackIframeUrl' in sanitized).toBe(false);
    expect(sanitized.rawUrl).toBeUndefined();
    expect(sanitized.resolvedUrl).toBeUndefined();
    expect(sanitized.fallbackIframeUrl).toBeUndefined();
  });

  it('4. impede que URLs originais protegidas ou metadados extras apareçam em propriedades aninhadas do payload', () => {
    const protectedOrigin = 'https://secret-origin.example.test/private/ep01/stream.m3u8';
    const sourceWithExtraProps = {
      slot: 1 as const,
      label: 'Player 1',
      rawUrl: protectedOrigin,
      resolvedUrl: protectedOrigin,
      fallbackIframeUrl: 'https://secret-embed.example.test/embed/123',
      kind: 'hls' as const,
      provider: 'hls' as const,
      needsProxy: true as const,
      requiresServerResolve: false,
      formatLabel: 'HLS',
      playUrl: buildSignedProxyPath(protectedOrigin),
      nestedMetadata: {
        upstreamUrl: protectedOrigin,
        rawUrl: protectedOrigin,
      },
      sourceReferer: 'https://private-referer.example.test/',
    };

    const sanitized = sanitizePlayableSourceForPublic(sourceWithExtraProps as InternalPlayableSource);
    const serialized = JSON.stringify(sanitized);

    expect(Object.keys(sanitized).sort()).toEqual([
      'formatLabel',
      'kind',
      'label',
      'needsProxy',
      'playUrl',
      'provider',
      'requiresServerResolve',
      'slot',
    ]);
    expect(serialized).not.toContain('secret-origin.example.test/private');
    expect(serialized).not.toContain('secret-embed.example.test');
    expect(serialized).not.toContain('private-referer.example.test');
    expect(serialized).not.toContain('nestedMetadata');
  });

  it('5. preserva a URL interna assinada do proxy (playUrl) e source_referer quando needsProxy === true', () => {
    const protectedUrl = 'https://cdn-private.example.test/hls/ep01/master.m3u8';
    const customReferer = 'https://custom-ref.example.test/';
    const ep = makeEpisode({
      video_url: protectedUrl,
      source_kind: 'hls',
      source_referer: customReferer,
    });

    const result = buildPublicEpisodeResult(ep);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    const src = result.episode.sources[0];
    expect(src.needsProxy).toBe(true);
    expect(src.playUrl.startsWith('/api/proxy/stream?')).toBe(true);
    expect('rawUrl' in src).toBe(false);
    expect('resolvedUrl' in src).toBe(false);

    const parsedProxy = new URL(`http://localhost${src.playUrl}`);
    expect(
      verifyProxySignature(
        parsedProxy.searchParams.get('url') ?? '',
        parsedProxy.searchParams.get('exp'),
        parsedProxy.searchParams.get('sig')
      )
    ).toBe(true);
    expect(
      verifyProxyReferer(
        parsedProxy.searchParams.get('url') ?? '',
        parsedProxy.searchParams.get('exp'),
        parsedProxy.searchParams.get('ref'),
        parsedProxy.searchParams.get('rsig')
      )
    ).toEqual({
      valid: true,
      referer: customReferer,
    });
  });

  it('6. preserva o comportamento direto completo quando needsProxy === false', () => {
    const mirrorBlobUrl =
      'https://teststore.public.blob.vercel-storage.com/mirrors/anime-ficticio/ep01.mp4';
    const directIframeUrl = 'https://animesdigital.org/embed/fake-ep-01';
    const bunnyUrl = 'https://player.mediadelivery.net/embed/99999/11111111-2222-3333-4444-555555555555';
    const directMp4Url = 'https://direct-cdn.example.test/videos/ep01.mp4';

    const ep = makeEpisode({
      video_url: mirrorBlobUrl,
      is_mirror: true,
      video_url_2: directIframeUrl,
      source_kind_2: 'iframe',
      video_url_3: bunnyUrl,
      video_url_4: directMp4Url,
      source_kind_4: 'mp4',
      force_proxy_4: false,
    });

    const result = buildPublicEpisodeResult(ep);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    const bySlot = new Map(result.episode.sources.map((s) => [s.slot, s]));

    const s1 = bySlot.get(1);
    expect(s1?.needsProxy).toBe(false);
    expect(s1?.rawUrl).toBe(mirrorBlobUrl);
    expect(s1?.resolvedUrl).toBe(mirrorBlobUrl);
    expect(s1?.playUrl).toBe(mirrorBlobUrl);

    const s2 = bySlot.get(2);
    expect(s2?.needsProxy).toBe(false);
    expect(s2?.rawUrl).toBe(directIframeUrl);
    expect(s2?.resolvedUrl).toBe(directIframeUrl);
    expect(s2?.fallbackIframeUrl).toBe(directIframeUrl);
    expect(s2?.playUrl).toBe(directIframeUrl);

    const s3 = bySlot.get(3);
    expect(s3?.needsProxy).toBe(false);
    expect(s3?.requiresServerResolve).toBe(true);
    expect(s3?.rawUrl).toBe(bunnyUrl);
    expect(s3?.fallbackIframeUrl).toBe(
      'https://iframe.mediadelivery.net/embed/99999/11111111-2222-3333-4444-555555555555'
    );

    const s4 = bySlot.get(4);
    expect(s4?.needsProxy).toBe(false);
    expect(s4?.rawUrl).toBe(directMp4Url);
    expect(s4?.resolvedUrl).toBe(directMp4Url);
    expect(s4?.playUrl).toBe(directMp4Url);
  });

  it('7. preserva fallback autorizado do Maximaimg sem vazar URL protegida quando needsProxy === true', () => {
    const maximaHlsUrl = 'https://cdn-sv01.maximaimg.online/stream/fake-anime/01.mp4/index.m3u8';

    // 7a. Quando configurado explicitamente para reprodução direta (force_proxy: false) -> mantém funcionamento direto
    const directMaximaEp = makeEpisode({
      video_url: maximaHlsUrl,
      force_proxy: false,
    });
    const directResult = buildPublicEpisodeResult(directMaximaEp);
    expect(directResult.status).toBe('ok');
    if (directResult.status === 'ok') {
      const s = directResult.episode.sources[0];
      expect(s.provider).toBe('maximaimg');
      expect(s.needsProxy).toBe(false);
      expect(s.playUrl).toBe(maximaHlsUrl);
      expect(s.resolvedUrl).toBe(maximaHlsUrl);
    }

    // 7b. Quando proxied (needsProxy: true) -> não vaza resolvedUrl e canUseDirectMaximaimgFallback não revela nem quebra
    const proxiedMaximaEp = makeEpisode({
      video_url: maximaHlsUrl,
      force_proxy: true,
    });
    const proxiedResult = buildPublicEpisodeResult(proxiedMaximaEp);
    expect(proxiedResult.status).toBe('ok');
    if (proxiedResult.status === 'ok') {
      const s = proxiedResult.episode.sources[0];
      expect(s.provider).toBe('maximaimg');
      expect(s.needsProxy).toBe(true);
      expect('resolvedUrl' in s).toBe(false);
      expect(canUseDirectMaximaimgFallback(s, 'proxy', false)).toBe(false);
    }

    // 7c. Quando uma fonte Maximaimg HLS possui fallback direto autorizado (resolvedUrl presente e distinta de playUrl) -> continua funcionando
    const norm = normalizeVideoSource(maximaHlsUrl, 1)!;
    const authorizedFallbackSource: PlayableSource = {
      ...norm,
      playUrl: buildSignedProxyPath(norm.resolvedUrl),
    };
    const diagnostic403 = classifyHlsError({
      type: 'networkError',
      details: 'manifestLoadError',
      httpCode: 403,
      url: authorizedFallbackSource.playUrl,
    });
    expect(canUseDirectMaximaimgFallback(authorizedFallbackSource, 'proxy', false)).toBe(true);
    expect(
      decideHlsErrorAction({
        source: authorizedFallbackSource,
        strategy: 'proxy',
        alreadyAttemptedDirect: false,
        networkRetriesUsed: 0,
        mediaRecoveriesUsed: 0,
        diagnostic: diagnostic403,
      }).action
    ).toBe('fallback_direct');
  });

  it('8. sanitização é pura e não modifica o objeto original por mutação', () => {
    const internalSource: InternalPlayableSource = Object.freeze({
      slot: 1,
      label: 'Player 1',
      rawUrl: 'https://player.mux.com/FrozenMuxId99999',
      resolvedUrl: 'https://stream.mux.com/FrozenMuxId99999.m3u8',
      fallbackIframeUrl: 'https://player.mux.com/FrozenMuxId99999',
      kind: 'hls',
      provider: 'mux',
      needsProxy: true,
      requiresServerResolve: false,
      formatLabel: 'Mux · HLS',
      playUrl: '/api/proxy/stream?url=https%3A%2F%2Fstream.mux.com%2FFrozenMuxId99999.m3u8&exp=1&sig=x',
    });

    const sanitized = sanitizePlayableSourceForPublic(internalSource);

    expect(sanitized).not.toBe(internalSource);
    expect('rawUrl' in sanitized).toBe(false);
    expect('resolvedUrl' in sanitized).toBe(false);
    expect('fallbackIframeUrl' in sanitized).toBe(false);

    // Objeto original permanece intacto
    expect(internalSource.rawUrl).toBe('https://player.mux.com/FrozenMuxId99999');
    expect(internalSource.resolvedUrl).toBe('https://stream.mux.com/FrozenMuxId99999.m3u8');
    expect(internalSource.fallbackIframeUrl).toBe('https://player.mux.com/FrozenMuxId99999');
  });

  it('9. resposta SSR pública (/e/$id) não contém URLs originais protegidas quando needsProxy === true', () => {
    const secretMuxEmbed = 'https://player.mux.com/ProtectedMuxId888';
    const secretR2Url =
      'https://acct123.r2.cloudflarestorage.com/private/ep01.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=fakesig';
    const secretHlsUrl = 'https://protected-hls.example.test/stream/ep01/master.m3u8';

    const ep = makeEpisode({
      video_url: secretMuxEmbed,
      video_url_2: secretR2Url,
      source_kind_2: 'mp4',
      video_url_3: secretHlsUrl,
      source_kind_3: 'hls',
    });

    const publicPayload = buildPublicEpisodeResult(ep);
    const hydratedJson = JSON.stringify(publicPayload);

    expect(publicPayload.status).toBe('ok');
    if (publicPayload.status !== 'ok') return;

    for (const source of publicPayload.episode.sources) {
      expect(source.needsProxy).toBe(true);
      expect('rawUrl' in source).toBe(false);
      expect('resolvedUrl' in source).toBe(false);
      expect('fallbackIframeUrl' in source).toBe(false);
    }

    expect(hydratedJson).not.toContain('"rawUrl"');
    expect(hydratedJson).not.toContain('"resolvedUrl"');
    expect(hydratedJson).not.toContain('"fallbackIframeUrl"');
    expect(hydratedJson).not.toContain(secretMuxEmbed);
    expect(hydratedJson).not.toContain(secretR2Url);
    expect(hydratedJson).not.toContain(secretHlsUrl);

    // Confirma que a rota pública /e/$id consome exclusivamente getPublicEpisodeFn sem expor campos do banco
    const routeSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/routes/e/$id.tsx'),
      'utf8'
    );
    expect(routeSource).toContain('getPublicEpisodeFn');
    expect(routeSource).not.toContain('rawUrl');
    expect(routeSource).not.toContain('resolvedUrl');
    expect(routeSource).not.toContain('fallbackIframeUrl');
  });

  it('10. troca de episódios e failover entre slots continuam recebendo todos os dados necessários', () => {
    const ep1 = makeEpisode({
      id: 'ep_switch_01',
      episode_number: '01',
      title: 'Primeiro Episódio',
      video_url: 'https://cdn-a.example.test/ep01/master.m3u8',
      video_url_2: 'https://cdn-b.example.test/ep01/video.mp4',
    });
    const ep2 = makeEpisode({
      id: 'ep_switch_02',
      episode_number: '02',
      title: 'Segundo Episódio',
      video_url: 'https://cdn-a.example.test/ep02/master.m3u8',
      video_url_2: 'https://teststore.public.blob.vercel-storage.com/mirrors/anime/ep02.mp4',
      is_mirror_2: true,
    });

    const res1 = buildPublicEpisodeResult(ep1);
    const res2 = buildPublicEpisodeResult(ep2);

    expect(res1.status).toBe('ok');
    expect(res2.status).toBe('ok');
    if (res1.status !== 'ok' || res2.status !== 'ok') return;

    expect(res1.episode.id).toBe('ep_switch_01');
    expect(res1.episode.sources).toHaveLength(2);
    expect(res1.episode.sources[0].playUrl).toContain('/api/proxy/stream?');
    expect(getNextFallbackSourceIndex(res1.episode.sources, 0, new Set([1]))).toBe(1);

    expect(res2.episode.id).toBe('ep_switch_02');
    expect(res2.episode.sources).toHaveLength(2);
    // Espelho Blob é priorizado primeiro com reprodução direta e segunda fonte segue sanitizada
    expect(res2.episode.sources[0].isMirror).toBe(true);
    expect(res2.episode.sources[0].needsProxy).toBe(false);
    expect(res2.episode.sources[0].playUrl).toContain('public.blob.vercel-storage.com');

    expect(res2.episode.sources[1].needsProxy).toBe(true);
    expect('rawUrl' in res2.episode.sources[1]).toBe(false);
    expect('resolvedUrl' in res2.episode.sources[1]).toBe(false);
    expect(res2.episode.sources[1].playUrl).toContain('/api/proxy/stream?');
  });
});
