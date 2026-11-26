import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { extractBunnyHlsFromHtml } from '@/lib/bunny';
import { sanitizeEpisodeInput } from '@/lib/db';
import { buildSignedProxyPath } from '@/lib/proxy-signing';
import { resolveProxyPlayUrl } from '@/lib/server-fns';
import { diagnoseVideoSource } from '@/lib/source-diagnostics';
import {
  buildIframeSrcWithFreshTime,
  collectEpisodeSources,
  detectSourceKind,
  extractExpirableTokenRemainingSeconds,
  getIframeReferrerPolicy,
  getNextFallbackSourceIndex,
  hasExpirableHlsTokens,
  hasR2SignedQueryParams,
  hasUrlHashParams,
  inspectGoogleVideoSourceUrl,
  inspectR2SourceUrl,
  isExpirableHlsSourceUrl,
  isGoogleVideoHost,
  isGoogleVideoUrl,
  isR2StorageHost,
  isR2StorageUrl,
  MAX_VIDEO_SOURCE_URL_LENGTH,
  normalizeVideoSource,
  validateHttpUrl,
  validateVideoSourceUrl,
} from '@/lib/video-sources';

describe('validateHttpUrl', () => {
  it('aceita URLs HTTP e HTTPS válidas e remove espaços extras', () => {
    const res = validateHttpUrl('  https://cdn.example.com/video.mp4  ');
    expect(res.valid).toBe(true);
    expect(res.normalizedUrl).toBe('https://cdn.example.com/video.mp4');
  });

  it('rejeita esquemas perigosos e URLs inválidas', () => {
    expect(validateHttpUrl('javascript:alert(1)').valid).toBe(false);
    expect(validateHttpUrl('data:text/html,<script>').valid).toBe(false);
    expect(validateHttpUrl('file:///etc/passwd').valid).toBe(false);
    expect(validateHttpUrl('ftp://cdn.example.com/ep1.mp4').valid).toBe(false);
    expect(validateHttpUrl('https://user:pass@cdn.example.com/ep1.mp4').valid).toBe(false);
    expect(validateHttpUrl('').valid).toBe(false);
    expect(validateHttpUrl('não é uma url').valid).toBe(false);
  });
});

describe('normalizeVideoSource', () => {
  it('identifica vídeos diretos MP4 e WebM', () => {
    const mp4 = normalizeVideoSource('https://cdn.example.com/anime/ep01.mp4?token=abc', 1);
    expect(mp4?.kind).toBe('mp4');
    expect(mp4?.provider).toBe('direct');
    expect(mp4?.needsProxy).toBe(true);

    const webm = normalizeVideoSource('https://cdn.example.com/anime/ep01.webm', 2);
    expect(webm?.kind).toBe('webm');
    expect(webm?.provider).toBe('direct');
  });

  it('identifica streams HLS (.m3u8 e .m3u)', () => {
    const m3u8 = normalizeVideoSource('https://cdn.example.com/hls/master.m3u8', 1);
    expect(m3u8?.kind).toBe('hls');
    expect(m3u8?.provider).toBe('hls');

    const m3u = normalizeVideoSource('https://cdn.example.com/playlist.m3u', 2);
    expect(m3u?.kind).toBe('hls');
  });

  it('converte URLs player.mux.com para stream.mux.com com playlist M3U8', () => {
    const mux = normalizeVideoSource('https://player.mux.com/AbCdEfGhIj123456?token=xyz', 1);
    expect(mux?.kind).toBe('hls');
    expect(mux?.provider).toBe('mux');
    expect(mux?.resolvedUrl).toBe('https://stream.mux.com/AbCdEfGhIj123456.m3u8?token=xyz');
    expect(mux?.fallbackIframeUrl).toBe('https://player.mux.com/AbCdEfGhIj123456?token=xyz');

    const muxDirect = normalizeVideoSource('https://stream.mux.com/AbCdEfGhIj123456.m3u8', 2);
    expect(muxDirect?.kind).toBe('hls');
    expect(muxDirect?.provider).toBe('mux');
  });

  it('reconhece URLs Bunny Stream (player.mediadelivery.net/embed) e extrai HLS do HTML', () => {
    const bunny = normalizeVideoSource(
      'https://player.mediadelivery.net/embed/12345/9c9d7a3b-1234-4567-89ab-cdef01234567?autoplay=false',
      1
    );
    expect(bunny?.kind).toBe('bunny');
    expect(bunny?.provider).toBe('bunny');
    expect(bunny?.requiresServerResolve).toBe(true);
    expect(bunny?.fallbackIframeUrl).toBe(
      'https://iframe.mediadelivery.net/embed/12345/9c9d7a3b-1234-4567-89ab-cdef01234567?autoplay=false'
    );

    const mockHtml = `<script>var src = "https://vz-a1b2c3d4-001.b-cdn.net/9c9d7a3b-1234-4567-89ab-cdef01234567/playlist.m3u8";</script>`;
    const extracted = extractBunnyHlsFromHtml(
      mockHtml,
      '9c9d7a3b-1234-4567-89ab-cdef01234567'
    );
    expect(extracted).toBe(
      'https://vz-a1b2c3d4-001.b-cdn.net/9c9d7a3b-1234-4567-89ab-cdef01234567/playlist.m3u8'
    );
  });

  it('marca fontes maximaimg.online para proxy dedicado', () => {
    const maxHls = normalizeVideoSource('https://cdn.maximaimg.online/stream/ep1/index.m3u8', 1);
    expect(maxHls?.provider).toBe('maximaimg');
    expect(maxHls?.kind).toBe('hls');
    expect(maxHls?.needsProxy).toBe(true);

    const maxMp4 = normalizeVideoSource('https://maximaimg.online/files/ep1.mp4', 2);
    expect(maxMp4?.provider).toBe('maximaimg');
    expect(maxMp4?.kind).toBe('mp4');
    expect(maxMp4?.needsProxy).toBe(true);
  });

  it('trata páginas HTML e incorporações como iframe e nunca como MP4', () => {
    const htmlPage = normalizeVideoSource('https://embeds.example.com/watch/episodio-1.html', 1);
    expect(htmlPage?.kind).toBe('iframe');
    expect(htmlPage?.provider).toBe('iframe');

    const embedRoute = normalizeVideoSource('https://streamtape.com/e/abc123def/', 2);
    expect(embedRoute?.kind).toBe('iframe');
  });
});

describe('collectEpisodeSources e seleção/fallback de fontes', () => {
  it('coleta até 5 fontes válidas e alterna automaticamente ignorando fontes com falha', () => {
    const sources = collectEpisodeSources({
      video_url: 'https://cdn.example.com/ep1.mp4',
      video_url_2: 'https://player.mux.com/Playback123456',
      video_url_3: '',
      video_url_4: 'https://cdn.maximaimg.online/ep1/master.m3u8',
      video_url_5: 'https://embeds.example.com/e/12345',
    });

    expect(sources.map((s) => s.slot)).toEqual([1, 2, 4, 5]);
    expect(sources[0].label).toBe('Player 1');
    expect(sources[2].label).toBe('Player 4');

    const failed = new Set<number>([1]);
    const next1 = getNextFallbackSourceIndex(sources, 0, failed);
    expect(next1).toBe(1); // Player 2

    failed.add(2);
    const next2 = getNextFallbackSourceIndex(sources, 1, failed);
    expect(next2).toBe(2); // Player 4

    failed.add(4);
    const next3 = getNextFallbackSourceIndex(sources, 2, failed);
    expect(next3).toBe(3); // Player 5

    failed.add(5);
    const exhausted = getNextFallbackSourceIndex(sources, 3, failed);
    expect(exhausted).toBeNull();
  });

  it('detecta kind automático (playerricas.php/.php -> iframe, .m3u8 -> hls, .mp4/.webm -> mp4) e respeita override explícito', () => {
    const playerricas =
      'https://www.anitube22.vip/playerricas.php?name=apphd/583375.mp4&img=https://www.hinatasoul.com/media/videos/tmb/583375/default.jpg&pais=pais=BR&time=1700000000&url=https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/ziphonec/583375.mp4';
    const phpHls =
      'https://api.anivideo.net/videohls.php?d=https://cdn-sv01.maximaimg.online/stream/b/bakemonogatari/01.mp4/index.m3u8';

    expect(detectSourceKind(playerricas)).toBe('iframe');
    expect(detectSourceKind(phpHls)).toBe('iframe');
    expect(detectSourceKind('https://cdn-sv01.maximaimg.online/ep1/index.m3u8')).toBe('hls');
    expect(detectSourceKind('https://cdn.example.com/ep1.mp4')).toBe('mp4');
    expect(detectSourceKind('https://cdn.example.com/ep1.webm')).toBe('mp4');

    // Override explícito
    expect(detectSourceKind('https://cdn.example.com/custom-player', 'iframe')).toBe('iframe');
    expect(detectSourceKind('https://cdn.example.com/stream', 'hls')).toBe('hls');
    expect(detectSourceKind('https://cdn.example.com/stream', 'mp4')).toBe('mp4');

    // normalizeVideoSource para playerricas.php / .php garante kind='iframe' e needsProxy=false
    const norm1 = normalizeVideoSource(playerricas, 1);
    expect(norm1?.kind).toBe('iframe');
    expect(norm1?.needsProxy).toBe(false);
    expect(norm1?.resolvedUrl).toBe(playerricas);

    const norm2 = normalizeVideoSource(phpHls, 2);
    expect(norm2?.kind).toBe('iframe');
    expect(norm2?.needsProxy).toBe(false);
  });

  it('substitui apenas o parâmetro time em URLs de iframe na montagem e preserva URLs sem time', () => {
    const withTime =
      'https://www.anitube22.vip/playerricas.php?name=apphd/583375.mp4&img=https://www.hinatasoul.com/media/videos/tmb/583375/default.jpg&pais=pais=BR&time=1700000000&url=https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/ziphonec/583375.mp4';
    const updated1 = buildIframeSrcWithFreshTime(withTime, 1795120001);
    const updated2 = buildIframeSrcWithFreshTime(withTime, 1795120015);

    expect(updated1).toContain('time=1795120001');
    expect(updated2).toContain('time=1795120015');
    expect(updated1).not.toBe(updated2);
    expect(updated1).toContain('pais=pais=BR');
    expect(updated1).toContain('url=https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/ziphonec/583375.mp4');

    const withoutTime = 'https://embeds.example.com/e/12345?runtime=900';
    expect(buildIframeSrcWithFreshTime(withoutTime, 1795120001)).toBe(withoutTime);
  });

  it('não reescreve time quando a URL possui parâmetros de hash (cv, cv2, cv3, cv4) e detecta hasUrlHashParams', () => {
    const urls = [
      'https://filevideo1.com/remote_control.php?time=1700000000&cv=abc123&file=ep.mp4',
      'https://filevideo1.com/remote_control.php?time=1700000000&cv2=def456&file=ep.mp4',
      'https://filevideo1.com/remote_control.php?time=1700000000&cv3=ghi789&file=ep.mp4',
      'https://filevideo1.com/remote_control.php?time=1700000000&cv4=jkl012&file=ep.mp4',
      'https://filevideo1.com/remote_control.php?file=ep.mp4&time=1700000000&cv=a&cv2=b&cv3=c&cv4=d',
    ];

    for (const url of urls) {
      expect(hasUrlHashParams(url)).toBe(true);
      expect(buildIframeSrcWithFreshTime(url, 1795120999)).toBe(url);
      expect(getIframeReferrerPolicy(url)).toBe('no-referrer');
      const norm = normalizeVideoSource(url, 1);
      expect(norm?.kind).toBe('iframe');
      expect(norm?.needsProxy).toBe(false);
    }

    expect(
      hasUrlHashParams('https://www.anitube22.vip/playerricas.php?id=123&time=1700000000')
    ).toBe(false);
  });

  it('ativa needsProxy=true por padrão para fontes hls/mp4 (incluindo mywallpaper-4k-image.net) e mantém false apenas para iframe', () => {
    const wallpaperHls = normalizeVideoSource(
      'https://cdn-s01.mywallpaper-4k-image.net/stream/anime/01/index.m3u8',
      1
    );
    expect(wallpaperHls?.kind).toBe('hls');
    expect(wallpaperHls?.needsProxy).toBe(true);

    const genericMp4 = normalizeVideoSource('https://cdn.example.com/ep01.mp4', 2);
    expect(genericMp4?.kind).toBe('mp4');
    expect(genericMp4?.needsProxy).toBe(true);

    const iframe = normalizeVideoSource('https://embeds.example.com/player.html', 3);
    expect(iframe?.kind).toBe('iframe');
    expect(iframe?.needsProxy).toBe(false);
  });
});

describe('Classificação, assinatura e diagnóstico de links Cloudflare R2', () => {
  const unsignedR2Url =
    'https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/z333/229033.mp4';
  const signedR2Url =
    'https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/z333/229033.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=cred%2F20261125%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261125T180000Z&X-Amz-Expires=7200&X-Amz-SignedHeaders=host&X-Amz-Signature=deadbeef';
  const customAuthR2Url =
    'https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/z333/229033.mp4?token=abc123';
  const publicMp4Url = 'https://cdn.example.com/anime/ep01.mp4';
  const blobMp4Url = 'https://abc123.public.blob.vercel-storage.com/mirrors/anime/ep01.mp4';

  it('classifica qualquer URL *.r2.cloudflarestorage.com como potencialmente temporária sem tornar MP4 comum ou Vercel Blob temporários', () => {
    expect(isR2StorageHost('173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com')).toBe(true);
    expect(isR2StorageHost('cdn.example.com')).toBe(false);
    expect(isR2StorageHost('abc123.public.blob.vercel-storage.com')).toBe(false);

    expect(isR2StorageUrl(unsignedR2Url)).toBe(true);
    expect(isR2StorageUrl(signedR2Url)).toBe(true);
    expect(isR2StorageUrl(customAuthR2Url)).toBe(true);
    expect(isR2StorageUrl(publicMp4Url)).toBe(false);
    expect(isR2StorageUrl(blobMp4Url)).toBe(false);

    expect(hasR2SignedQueryParams(unsignedR2Url)).toBe(false);
    expect(hasR2SignedQueryParams(signedR2Url)).toBe(true);

    expect(normalizeVideoSource(unsignedR2Url, 1)?.isExpirable).toBe(true);
    expect(normalizeVideoSource(signedR2Url, 1)?.isExpirable).toBe(true);
    expect(normalizeVideoSource(customAuthR2Url, 1)?.isExpirable).toBe(true);
    expect(normalizeVideoSource(unsignedR2Url, 1, 'mp4')?.isExpirable).toBe(true);

    // MP4 público comum e Vercel Blob não são marcados como temporários
    expect(normalizeVideoSource(publicMp4Url, 1)?.isExpirable).toBeUndefined();
    expect(normalizeVideoSource(blobMp4Url, 1)?.isExpirable).toBeUndefined();
    expect(normalizeVideoSource(blobMp4Url, 1)?.isMirror).toBe(true);
    expect(normalizeVideoSource(blobMp4Url, 1)?.needsProxy).toBe(false);
    expect(isExpirableHlsSourceUrl(publicMp4Url)).toBe(false);
  });

  it('diferencia corretamente R2 com assinatura X-Amz-* e R2 sem assinatura para avisos do Admin e diagnóstico', async () => {
    const unsignedInfo = inspectR2SourceUrl(unsignedR2Url);
    expect(unsignedInfo.isR2).toBe(true);
    expect(unsignedInfo.hasAmzSignature).toBe(false);
    expect(unsignedInfo.status).toBe('r2_unsigned');
    expect(unsignedInfo.badgeLabel).toContain('sem assinatura');
    expect(unsignedInfo.warningMessage).toContain('Cloudflare R2');
    expect(unsignedInfo.warningMessage).toContain('sem parâmetros de assinatura');
    expect(unsignedInfo.warningMessage).toContain('Guardar cópia');

    const signedInfo = inspectR2SourceUrl(signedR2Url);
    expect(signedInfo.isR2).toBe(true);
    expect(signedInfo.hasAmzSignature).toBe(true);
    expect(signedInfo.status).toBe('r2_signed');
    expect(signedInfo.badgeLabel).toContain('assinatura temporária');
    expect(signedInfo.warningMessage).toContain('assinatura X-Amz-*');
    expect(signedInfo.warningMessage).toContain('Guardar cópia');

    expect(inspectR2SourceUrl(publicMp4Url).status).toBe('none');
    expect(inspectR2SourceUrl(blobMp4Url).status).toBe('none');

    // Admin usa inspectR2SourceUrl e renderiza badge e aviso específicos
    const adminSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/routes/admin.tsx'),
      'utf8'
    );
    expect(adminSource).toContain('inspectR2SourceUrl');
    expect(adminSource).toContain("status === 'r2_unsigned'");
    expect(adminSource).toContain('primarySourceInfo?.r2Inspection.warningMessage');

    // Diagnóstico de fonte marca R2 MP4 sem assinatura como expirável
    const diag = await diagnoseVideoSource(
      { slot: 1, url: unsignedR2Url },
      {
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(null, { status: 403 }),
        }),
      }
    );
    expect(diag.isExpirable).toBe(true);
    expect(diag.expirableReason).toContain('Cloudflare R2');
    expect(diag.expirableReason).toContain('sem parâmetros de assinatura');
  });

  it('assina URLs R2 com ex=1&xsig no proxy-signing e resolveProxyPlayUrl sem afetar MP4 público', () => {
    process.env.PLAYER_SESSION_SECRET = '0123456789abcdef0123456789abcdef';

    const r2ProxyPath = new URL(`http://localhost${buildSignedProxyPath(unsignedR2Url)}`);
    expect(r2ProxyPath.searchParams.get('ex')).toBe('1');
    expect(r2ProxyPath.searchParams.get('xsig')).toBeTruthy();

    const r2WorkerUrl = new URL(
      resolveProxyPlayUrl(unsignedR2Url, 'https://proxy.example.workers.dev')
    );
    expect(r2WorkerUrl.searchParams.get('ex')).toBe('1');
    expect(r2WorkerUrl.searchParams.get('xsig')).toBeTruthy();

    const publicProxyPath = new URL(`http://localhost${buildSignedProxyPath(publicMp4Url)}`);
    expect(publicProxyPath.searchParams.has('ex')).toBe(false);
    expect(publicProxyPath.searchParams.has('xsig')).toBe(false);
  });
});

describe('Suporte seguro a URLs Google Video (Etapa 1)', () => {
  beforeEach(() => {
    process.env.PLAYER_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
  });

  const baseGoogleVideoUrl =
    'https://rr2---sn-example-001.googlevideo.com/videoplayback?expire=1900000000&ei=fake_ei_value&ip=198.51.100.1&id=o-FAKEID123&itag=18&source=blogger&requiressl=yes&mime=video%2Fmp4&sparams=expire%2Cei%2Cip%2Cid%2Citag%2Csource%2Crequiressl%2Cmime&sig=FAKE_SIG_VALUE_ABC&lsig=FAKE_LSIG_VALUE_XYZ';

  it('classifica URLs legítimas de googlevideo.com/videoplayback como MP4 com proxy e sem depender de .mp4 no path', () => {
    expect(isGoogleVideoHost('googlevideo.com')).toBe(true);
    expect(isGoogleVideoHost('rr2---sn-example-001.googlevideo.com')).toBe(true);
    expect(isGoogleVideoUrl(baseGoogleVideoUrl)).toBe(true);
    expect(detectSourceKind(baseGoogleVideoUrl)).toBe('mp4');

    const norm = normalizeVideoSource(baseGoogleVideoUrl, 1);
    expect(norm).not.toBeNull();
    expect(norm?.kind).toBe('mp4');
    expect(norm?.provider).toBe('googlevideo');
    expect(norm?.needsProxy).toBe(true);
    expect(norm?.isExpirable).toBe(true);
    expect(norm?.formatLabel).toBe('Google Video · MP4');

    // Também reconhece mime=video/mp4 não codificado e /videoplayback sem mime explícito
    const decodedMimeUrl = baseGoogleVideoUrl.replace('mime=video%2Fmp4', 'mime=video/mp4');
    expect(detectSourceKind(decodedMimeUrl)).toBe('mp4');
    expect(normalizeVideoSource(decodedMimeUrl, 2)?.provider).toBe('googlevideo');

    const noMimePlayback =
      'https://googlevideo.com/videoplayback?expire=1900000000&itag=22&sig=FAKE_SIG_22';
    expect(detectSourceKind(noMimePlayback)).toBe('mp4');
    expect(normalizeVideoSource(noMimePlayback, 3)?.provider).toBe('googlevideo');
  });

  it('não classifica domínios falsos ou não-GoogleVideo como Google Video', () => {
    const spoofedHosts = [
      'googlevideo.com.exemplo.com',
      'fakegooglevideo.com',
      'rr1.googlevideo.org',
    ];

    for (const host of spoofedHosts) {
      expect(isGoogleVideoHost(host)).toBe(false);
      const fakeUrl = `https://${host}/videoplayback?mime=video%2Fmp4&sig=FAKE_SIG`;
      expect(isGoogleVideoUrl(fakeUrl)).toBe(false);
      const norm = normalizeVideoSource(fakeUrl, 1);
      expect(norm?.provider).not.toBe('googlevideo');
    }
  });

  it('respeita source_kind explícito informado pelo administrador em URLs Google Video', () => {
    const asIframe = normalizeVideoSource(baseGoogleVideoUrl, 1, 'iframe');
    expect(asIframe?.kind).toBe('iframe');
    expect(asIframe?.needsProxy).toBe(false);

    const asHls = normalizeVideoSource(baseGoogleVideoUrl, 1, 'hls');
    expect(asHls?.kind).toBe('hls');
    expect(asHls?.needsProxy).toBe(true);
    expect(asHls?.isExpirable).toBe(true);

    const asMp4 = normalizeVideoSource(baseGoogleVideoUrl, 1, 'mp4');
    expect(asMp4?.kind).toBe('mp4');
    expect(asMp4?.provider).toBe('googlevideo');
    expect(asMp4?.needsProxy).toBe(true);
    expect(asMp4?.isExpirable).toBe(true);
  });

  it('aceita URLs de fonte de vídeo acima de 2.048 até 8.192 caracteres mantendo 2.048 para outros campos', () => {
    expect(MAX_VIDEO_SOURCE_URL_LENGTH).toBe(8192);

    const padding = 'x'.repeat(2600);
    const longGoogleVideoUrl = `${baseGoogleVideoUrl}&extra_pad=${padding}`;
    expect(longGoogleVideoUrl.length).toBeGreaterThan(2048);
    expect(longGoogleVideoUrl.length).toBeLessThan(8192);

    // Fontes de vídeo aceitam até 8.192
    expect(validateVideoSourceUrl(longGoogleVideoUrl).valid).toBe(true);
    expect(detectSourceKind(longGoogleVideoUrl)).toBe('mp4');
    expect(normalizeVideoSource(longGoogleVideoUrl, 1)?.resolvedUrl).toBe(longGoogleVideoUrl);

    const sanitized = sanitizeEpisodeInput({
      anime_name: 'Anime Teste',
      episode_number: '1',
      title: 'Episódio 1',
      poster_url: 'https://cdn.example.com/poster.jpg',
      video_url: longGoogleVideoUrl,
      video_url_2: longGoogleVideoUrl,
    });
    expect(sanitized.video_url).toBe(longGoogleVideoUrl);
    expect(sanitized.video_url_2).toBe(longGoogleVideoUrl);

    // Limite de 8.192 é respeitado
    const tooLongVideoUrl = `${baseGoogleVideoUrl}&extra_pad=${'y'.repeat(8200)}`;
    expect(validateVideoSourceUrl(tooLongVideoUrl).valid).toBe(false);
    expect(() =>
      sanitizeEpisodeInput({
        title: 'Episódio Longo Demais',
        poster_url: 'https://cdn.example.com/poster.jpg',
        video_url: tooLongVideoUrl,
      })
    ).toThrow(/limite máximo/i);

    // Campos não-fonte (poster_url e source_referer) continuam limitados a 2.048
    const longPoster = `https://cdn.example.com/poster.jpg?pad=${'z'.repeat(2100)}`;
    expect(() =>
      sanitizeEpisodeInput({
        title: 'Poster Longo',
        poster_url: longPoster,
        video_url: 'https://cdn.example.com/ep01.mp4',
      })
    ).toThrow(/Imagem de capa inválida/i);

    const longReferer = `https://provedor.example.com/watch?pad=${'r'.repeat(2100)}`;
    expect(() =>
      sanitizeEpisodeInput({
        title: 'Referer Longo',
        poster_url: 'https://cdn.example.com/poster.jpg',
        video_url: 'https://cdn.example.com/ep01.mp4',
        source_referer: longReferer,
      })
    ).toThrow(/Referer da fonte inválido/i);
  });

  it('preserva exatamente parâmetros assinados na normalização e no encaminhamento ao proxy', () => {
    const validated = validateVideoSourceUrl(baseGoogleVideoUrl);
    expect(validated.valid).toBe(true);
    expect(validated.normalizedUrl).toBe(baseGoogleVideoUrl);

    const norm = normalizeVideoSource(baseGoogleVideoUrl, 1);
    expect(norm?.resolvedUrl).toBe(baseGoogleVideoUrl);

    const proxyPath = buildSignedProxyPath(norm!.resolvedUrl, undefined, 1_800_000_000);
    const parsedProxy = new URL(`http://localhost${proxyPath}`);
    expect(parsedProxy.searchParams.get('url')).toBe(baseGoogleVideoUrl);
    expect(parsedProxy.searchParams.get('ex')).toBe('1');
    expect(parsedProxy.searchParams.get('xsig')).toBeTruthy();

    const workerPlayUrl = new URL(
      resolveProxyPlayUrl(
        norm!.resolvedUrl,
        'https://proxy.example.workers.dev',
        1_800_000_000,
        null,
        norm?.isExpirable
      )
    );
    expect(workerPlayUrl.searchParams.get('url')).toBe(baseGoogleVideoUrl);
    expect(workerPlayUrl.searchParams.get('ex')).toBe('1');
    expect(workerPlayUrl.searchParams.get('xsig')).toBeTruthy();
  });

  it('detecta tokens expire/sig/lsig e extrai TTL de expire sem falsos positivos em parâmetros de identificação', () => {
    expect(hasExpirableHlsTokens('https://cdn.example.com/ep.mp4?expire=1900000000')).toBe(true);
    expect(hasExpirableHlsTokens('https://cdn.example.com/ep.mp4?lsig=FAKE_LSIG')).toBe(true);
    expect(hasExpirableHlsTokens(baseGoogleVideoUrl)).toBe(true);

    // Parâmetros de identificação comuns (id, ip, itag, ei, sparams) não são tratados como expiráveis
    expect(
      hasExpirableHlsTokens(
        'https://cdn.example.com/video.mp4?id=123&ip=198.51.100.1&itag=18&ei=abc&sparams=id,ip'
      )
    ).toBe(false);

    const now = 1_899_996_400;
    expect(extractExpirableTokenRemainingSeconds(baseGoogleVideoUrl, now)).toBe(3600);
  });

  it('fornece diagnóstico e badge informativo de Google Video temporário sem afetar Admin', async () => {
    const info = inspectGoogleVideoSourceUrl(baseGoogleVideoUrl);
    expect(info.isGoogleVideo).toBe(true);
    expect(info.hasSignedParams).toBe(true);
    expect(info.hasExpireParam).toBe(true);
    expect(info.badgeLabel).toBe('Google Video · temporário');
    expect(info.warningMessage).toContain('Google Video');

    expect(inspectGoogleVideoSourceUrl('https://cdn.example.com/ep01.mp4').isGoogleVideo).toBe(
      false
    );

    const adminSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/routes/admin.tsx'),
      'utf8'
    );
    expect(adminSource).toContain('MAX_VIDEO_SOURCE_URL_LENGTH');
    expect(adminSource).toContain('inspectGoogleVideoSourceUrl');

    const diag = await diagnoseVideoSource(
      { slot: 1, url: baseGoogleVideoUrl },
      {
        fetchWithRedirects: async (url) => ({
          finalUrl: url,
          response: new Response(null, { status: 403 }),
        }),
      }
    );
    expect(diag.detectedKind).toBe('mp4');
    expect(diag.isExpirable).toBe(true);
    expect(diag.expirableReason).toContain('Google Video');
  });
});
