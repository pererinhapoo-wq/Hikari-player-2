import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyHlsError } from '@/lib/hls-playback';
import {
  classifyPlaybackSourceCategory,
  computePlaybackDiagnosticsSummary,
  containsSensitiveDiagnosticData,
  createPlaybackDiagnosticsCollector,
  mapHlsErrorToDiagnostic,
  MAX_SESSION_DIAGNOSTIC_EVENTS,
  sanitizeDiagnosticEvent,
} from '@/lib/playback-diagnostics';
import {
  clearPlaybackDiagnosticsStore,
  getPlaybackDiagnosticsSnapshot,
  MAX_SERVER_DIAGNOSTIC_EVENTS,
  recordDiagnosticEventsBatch,
} from '@/lib/playback-diagnostics-store';
import type { PlayableSource } from '@/lib/types';
import { handlePlaybackDiagnosticsPost } from '@/routes/api/playback-diagnostics';

function makeSource(
  overrides: Partial<PlayableSource> & Pick<PlayableSource, 'kind' | 'provider'>
): PlayableSource {
  return {
    slot: 1,
    label: 'Player 1',
    rawUrl: 'https://cdn.example.com/video/ep01',
    resolvedUrl: 'https://cdn.example.com/video/ep01',
    needsProxy: false,
    requiresServerResolve: false,
    formatLabel: 'HLS',
    playUrl: 'https://cdn.example.com/video/ep01',
    ...overrides,
  };
}

describe('Hikari Player — Diagnóstico de falhas e estabilidade do streaming', () => {
  beforeEach(() => {
    clearPlaybackDiagnosticsStore();
  });

  it('1. registra reprodução normal com tempos de carregamento e início sem inventar métricas sem dados', () => {
    const emptySummary = computePlaybackDiagnosticsSummary([]);
    expect(emptySummary.playsStarted).toBe(0);
    expect(emptySummary.playsCompleted).toBe(0);
    expect(emptySummary.failureRate).toBeNull();
    expect(emptySummary.averageStartupMs).toBeNull();
    expect(emptySummary.averageInitialLoadMs).toBeNull();
    expect(emptySummary.topErrorCategories).toEqual([]);

    const sentBatches: unknown[][] = [];
    let currentTime = 1_000_000;
    const collector = createPlaybackDiagnosticsCollector({
      nowMs: () => currentTime,
      transport: (events) => {
        sentBatches.push(events);
      },
    });

    collector.record({
      type: 'play_clicked',
      slot: 1,
      sourceCategory: 'hls_m3u8',
      deliveryMode: 'direct',
    });

    currentTime += 180;
    collector.record({
      type: 'initial_loaded',
      slot: 1,
      sourceCategory: 'hls_m3u8',
      deliveryMode: 'direct',
      durationMs: 180,
    });

    currentTime += 140;
    collector.record({
      type: 'playback_started',
      slot: 1,
      sourceCategory: 'hls_m3u8',
      deliveryMode: 'direct',
      durationMs: 320,
    });

    currentTime += 60_000;
    collector.record({
      type: 'playback_completed',
      slot: 1,
      sourceCategory: 'hls_m3u8',
      deliveryMode: 'direct',
    });

    const summary = collector.getSummary();
    expect(summary.playsStarted).toBe(1);
    expect(summary.playsCompleted).toBe(1);
    expect(summary.failureRate).toBe(0);
    expect(summary.averageInitialLoadMs).toBe(180);
    expect(summary.averageStartupMs).toBe(320);
    expect(summary.topErrorCategories).toEqual([]);
    // Enviado em lote nos marcos (playback_started e playback_completed), apenas 2 envios
    expect(sentBatches).toHaveLength(2);
    expect(sentBatches[0]).toHaveLength(3);
    expect(sentBatches[1]).toHaveLength(1);

    collector.dispose();
  });

  it('2. identifica eventos de buffering corretamente e contabiliza por categoria de fonte', () => {
    let now = 5_000;
    const collector = createPlaybackDiagnosticsCollector({
      nowMs: () => now,
      dedupWindowMs: 3000,
      transport: vi.fn(),
    });

    collector.record({
      type: 'playback_started',
      slot: 1,
      sourceCategory: 'maximaimg',
      deliveryMode: 'proxy',
      durationMs: 420,
    });

    now += 4_000;
    collector.record({
      type: 'buffering',
      slot: 1,
      sourceCategory: 'maximaimg',
      deliveryMode: 'proxy',
    });

    // Buffering repetido na mesma janela não duplica
    now += 500;
    collector.record({
      type: 'buffering',
      slot: 1,
      sourceCategory: 'maximaimg',
      deliveryMode: 'proxy',
    });

    // Novo buffering após cooldown conta normalmente
    now += 5_000;
    collector.record({
      type: 'buffering',
      slot: 1,
      sourceCategory: 'maximaimg',
      deliveryMode: 'proxy',
    });

    const summary = collector.getSummary();
    expect(summary.bufferingCount).toBe(2);
    expect(summary.categoryBreakdown[0].category).toBe('maximaimg');
    expect(summary.categoryBreakdown[0].bufferingCount).toBe(2);
    collector.dispose();
  });

  it('3. classifica corretamente categorias de origem e erros HTTP 403/404/429/5xx, timeout, M3U8 e segmentos HLS', () => {
    expect(classifyPlaybackSourceCategory(makeSource({ kind: 'mp4', provider: 'direct' }), 'direct')).toBe('mp4_direct');
    expect(classifyPlaybackSourceCategory(makeSource({ kind: 'webm', provider: 'direct' }), 'direct')).toBe('webm_direct');
    expect(classifyPlaybackSourceCategory(makeSource({ kind: 'hls', provider: 'hls' }), 'direct')).toBe('hls_m3u8');
    expect(classifyPlaybackSourceCategory(makeSource({ kind: 'hls', provider: 'maximaimg', needsProxy: true }), 'proxy')).toBe('maximaimg');
    expect(classifyPlaybackSourceCategory(makeSource({ kind: 'bunny', provider: 'bunny' }), 'direct')).toBe('bunny_mux');
    expect(classifyPlaybackSourceCategory(makeSource({ kind: 'hls', provider: 'mux' }), 'direct')).toBe('bunny_mux');
    expect(classifyPlaybackSourceCategory(makeSource({ kind: 'iframe', provider: 'iframe' }), 'iframe')).toBe('iframe');
    expect(classifyPlaybackSourceCategory(makeSource({ kind: 'hls', provider: 'hls', needsProxy: true }), 'proxy')).toBe('proxy');
    expect(classifyPlaybackSourceCategory(null, 'direct')).toBe('other');

    // Mapeamento de erros HLS
    const err403 = { type: 'networkError', details: 'manifestLoadError', httpCode: 403 };
    const mapped403 = mapHlsErrorToDiagnostic(err403, classifyHlsError(err403));
    expect(mapped403).toEqual({
      type: 'http_error',
      errorCode: 'http_403',
      httpStatus: 403,
      hlsResource: 'manifest',
    });

    const err404 = { type: 'networkError', details: 'fragLoadError', httpCode: 404 };
    const mapped404 = mapHlsErrorToDiagnostic(err404, classifyHlsError(err404));
    expect(mapped404).toEqual({
      type: 'http_error',
      errorCode: 'http_404',
      httpStatus: 404,
      hlsResource: 'segment',
    });

    const err429 = { type: 'networkError', details: 'fragLoadError', httpCode: 429 };
    const mapped429 = mapHlsErrorToDiagnostic(err429, classifyHlsError(err429));
    expect(mapped429).toEqual({
      type: 'http_error',
      errorCode: 'http_429',
      httpStatus: 429,
      hlsResource: 'segment',
    });

    const err503 = { type: 'networkError', details: 'fragLoadError', httpCode: 503 };
    const mapped503 = mapHlsErrorToDiagnostic(err503, classifyHlsError(err503));
    expect(mapped503).toEqual({
      type: 'http_error',
      errorCode: 'http_5xx',
      httpStatus: 503,
      hlsResource: 'segment',
    });

    const errTimeout = { type: 'networkError', details: 'manifestLoadTimeOut', httpCode: 0 };
    const mappedTimeout = mapHlsErrorToDiagnostic(errTimeout, classifyHlsError(errTimeout));
    expect(mappedTimeout).toEqual({
      type: 'timeout',
      errorCode: 'manifest_timeout',
      httpStatus: null,
      hlsResource: 'manifest',
    });

    const errSeg = { type: 'networkError', details: 'fragLoadError', httpCode: 0 };
    const mappedSeg = mapHlsErrorToDiagnostic(errSeg, classifyHlsError(errSeg));
    expect(mappedSeg).toEqual({
      type: 'segment_load_error',
      errorCode: 'segment_load_error',
      httpStatus: null,
      hlsResource: 'segment',
    });

    const summary = computePlaybackDiagnosticsSummary([
      {
        type: mapped403.type,
        timestamp: 1,
        sessionId: 's_test123',
        slot: 1,
        sourceCategory: 'maximaimg',
        deliveryMode: 'proxy',
        httpStatus: mapped403.httpStatus,
        errorCode: mapped403.errorCode,
        hlsResource: mapped403.hlsResource,
      },
      {
        type: mapped404.type,
        timestamp: 2,
        sessionId: 's_test123',
        slot: 2,
        sourceCategory: 'hls_m3u8',
        deliveryMode: 'direct',
        httpStatus: mapped404.httpStatus,
        errorCode: mapped404.errorCode,
        hlsResource: mapped404.hlsResource,
      },
      {
        type: mapped429.type,
        timestamp: 3,
        sessionId: 's_test123',
        slot: 2,
        sourceCategory: 'hls_m3u8',
        deliveryMode: 'direct',
        httpStatus: mapped429.httpStatus,
        errorCode: mapped429.errorCode,
        hlsResource: mapped429.hlsResource,
      },
      {
        type: mapped503.type,
        timestamp: 4,
        sessionId: 's_test123',
        slot: 2,
        sourceCategory: 'hls_m3u8',
        deliveryMode: 'direct',
        httpStatus: mapped503.httpStatus,
        errorCode: mapped503.errorCode,
        hlsResource: mapped503.hlsResource,
      },
      {
        type: mappedTimeout.type,
        timestamp: 5,
        sessionId: 's_test123',
        slot: 3,
        sourceCategory: 'proxy',
        deliveryMode: 'proxy',
        errorCode: mappedTimeout.errorCode,
        hlsResource: mappedTimeout.hlsResource,
      },
    ]);

    expect(summary.httpErrorsByCode).toEqual({ 403: 1, 404: 1, 429: 1, '5xx': 1 });
    expect(summary.timeoutErrors).toBe(1);
    expect(summary.manifestLoadErrors).toBe(2);
    expect(summary.segmentLoadErrors).toBe(3);
    expect(summary.topErrorCategories[0].category).toBe('hls_m3u8');
    expect(summary.topErrorCategories[0].errorCount).toBe(3);
  });

  it('4. contabiliza tentativas e recuperações HLS bem-sucedidas', () => {
    const collector = createPlaybackDiagnosticsCollector({ transport: vi.fn() });

    collector.record({
      type: 'hls_retry_scheduled',
      slot: 1,
      sourceCategory: 'hls_m3u8',
      deliveryMode: 'direct',
      attempt: 1,
      durationMs: 500,
    });
    collector.record({
      type: 'hls_recovery_media',
      slot: 1,
      sourceCategory: 'hls_m3u8',
      deliveryMode: 'direct',
      attempt: 1,
      errorCode: 'decode_error',
    });
    collector.record({
      type: 'hls_recovery_succeeded',
      slot: 1,
      sourceCategory: 'hls_m3u8',
      deliveryMode: 'direct',
      errorCode: 'network_recovery',
    });
    collector.record({
      type: 'hls_recovery_succeeded',
      slot: 1,
      sourceCategory: 'hls_m3u8',
      deliveryMode: 'direct',
      errorCode: 'media_recovery',
    });

    const summary = collector.getSummary();
    expect(summary.hlsRetryCount).toBe(1);
    expect(summary.hlsSuccessfulRecoveries).toBe(2);
    collector.dispose();
  });

  it('5. identifica failover, troca de fonte e falha definitiva da reprodução', () => {
    const collector = createPlaybackDiagnosticsCollector({ transport: vi.fn() });

    collector.record({
      type: 'playback_started',
      slot: 1,
      sourceCategory: 'maximaimg',
      deliveryMode: 'proxy',
      durationMs: 300,
    });
    collector.record({
      type: 'failover',
      slot: 1,
      sourceCategory: 'maximaimg',
      deliveryMode: 'proxy',
      errorCode: 'media_failover',
    });
    collector.record({
      type: 'source_switch',
      slot: 2,
      sourceCategory: 'mp4_direct',
      deliveryMode: 'direct',
      fromSlot: 1,
      toSlot: 2,
      switchReason: 'failover',
    });
    collector.record({
      type: 'fatal_playback_failure',
      slot: 2,
      sourceCategory: 'mp4_direct',
      deliveryMode: 'direct',
      errorCode: 'all_sources_failed',
    });

    const summary = collector.getSummary();
    expect(summary.failoverCount).toBe(1);
    expect(summary.fatalFailures).toBe(1);
    expect(summary.failureRate).toBe(1);
    collector.dispose();
  });

  it('6. evita registros duplicados em erros repetidos e respeita limite por sessão', () => {
    let now = 10_000;
    const collector = createPlaybackDiagnosticsCollector({
      nowMs: () => now,
      dedupWindowMs: 3000,
      maxSessionEvents: 5,
      transport: vi.fn(),
    });

    // 3 erros idênticos em 500ms -> apenas 1 registrado
    for (let i = 0; i < 3; i += 1) {
      now += 100;
      collector.record({
        type: 'http_error',
        slot: 1,
        sourceCategory: 'proxy',
        deliveryMode: 'proxy',
        httpStatus: 503,
        errorCode: 'http_5xx',
        hlsResource: 'segment',
      });
    }
    expect(collector.getEvents()).toHaveLength(1);

    // Respeita limite máximo por sessão (5 eventos)
    for (let i = 0; i < 10; i += 1) {
      now += 5_000;
      collector.record({
        type: 'buffering',
        slot: 1,
        sourceCategory: 'proxy',
        deliveryMode: 'proxy',
      });
    }
    expect(collector.getEvents()).toHaveLength(5);
    expect(MAX_SESSION_DIAGNOSTIC_EVENTS).toBe(60);
    collector.dispose();
  });

  it('7. bloqueia e sanitiza qualquer URL assinada, token, referer ou IP nos registros e endpoint', async () => {
    const taintedInput = {
      type: 'http_error',
      timestamp: Date.now(),
      sessionId: 's_privacy01',
      slot: 1,
      sourceCategory: 'maximaimg',
      deliveryMode: 'proxy',
      httpStatus: 403,
      errorCode: 'https://cdn.example.com/seg.ts?token=abc&sig=xyz&X-Amz-Signature=123',
      url: 'https://cdn-sv01.maximaimg.online/stream/ep01/index.m3u8?sig=secret',
      referer: 'https://www.anitube.biz/',
      ip: '192.168.1.50',
      cookie: 'session=secret123',
    };

    const sanitized = sanitizeDiagnosticEvent(taintedInput);
    expect(sanitized).not.toBeNull();
    expect(sanitized?.errorCode).toBeUndefined();
    expect((sanitized as unknown as Record<string, unknown>).url).toBeUndefined();
    expect((sanitized as unknown as Record<string, unknown>).referer).toBeUndefined();
    expect((sanitized as unknown as Record<string, unknown>).ip).toBeUndefined();
    expect((sanitized as unknown as Record<string, unknown>).cookie).toBeUndefined();
    expect(containsSensitiveDiagnosticData(sanitized)).toBe(false);

    const res = await handlePlaybackDiagnosticsPost(
      new Request('http://localhost/api/playback-diagnostics', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Referer: 'https://evil.example.com/?token=leak',
          Cookie: 'hikari_admin_session=secret',
          'X-Forwarded-For': '203.0.113.10',
        },
        body: JSON.stringify({ events: [taintedInput] }),
      })
    );
    expect(res.status).toBe(202);

    const snapshot = getPlaybackDiagnosticsSnapshot();
    expect(snapshot.retainedEventsCount).toBe(1);
    const serializedSnapshot = JSON.stringify(snapshot);
    expect(containsSensitiveDiagnosticData(serializedSnapshot)).toBe(false);
    expect(serializedSnapshot).not.toContain('maximaimg.online');
    expect(serializedSnapshot).not.toContain('anitube.biz');
    expect(serializedSnapshot).not.toContain('203.0.113.10');
    expect(serializedSnapshot).not.toContain('hikari_admin_session');
  });

  it('8. garante que a reprodução não quebra mesmo se o transporte de diagnóstico lançar erro ou rejeitar', async () => {
    const collector = createPlaybackDiagnosticsCollector({
      transport: () => {
        throw new Error('Diagnostics transport offline');
      },
    });

    expect(() => {
      collector.record({
        type: 'playback_started',
        slot: 1,
        sourceCategory: 'mp4_direct',
        deliveryMode: 'direct',
        durationMs: 120,
      });
      collector.flush();
    }).not.toThrow();

    const asyncRejectCollector = createPlaybackDiagnosticsCollector({
      transport: async () => {
        throw new Error('Network unreachable');
      },
    });

    expect(() => {
      asyncRejectCollector.record({
        type: 'fatal_playback_failure',
        slot: 1,
        sourceCategory: 'hls_m3u8',
        deliveryMode: 'direct',
        errorCode: 'all_sources_failed',
      });
    }).not.toThrow();

    collector.dispose();
    asyncRejectCollector.dispose();

    // Payload inválido no endpoint responde 400 sem exceção não tratada
    const badRes = await handlePlaybackDiagnosticsPost(
      new Request('http://localhost/api/playback-diagnostics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid-json',
      })
    );
    expect(badRes.status).toBe(400);
  });

  it('9. garante envio em lote sem requisições por segmento, limite de memória e painel admin protegido', async () => {
    vi.useFakeTimers();
    try {
      const transportSpy = vi.fn();
      const collector = createPlaybackDiagnosticsCollector({
        flushIntervalMs: 15_000,
        transport: transportSpy,
      });

      // Eventos intermediários (ex.: buffering, retry) aguardam batch sem disparar 1 fetch por evento
      collector.record({
        type: 'play_clicked',
        slot: 1,
        sourceCategory: 'hls_m3u8',
        deliveryMode: 'direct',
      });
      collector.record({
        type: 'initial_loaded',
        slot: 1,
        sourceCategory: 'hls_m3u8',
        deliveryMode: 'direct',
        durationMs: 250,
      });
      expect(transportSpy).not.toHaveBeenCalled();

      // Marco playback_started dispara 1 único lote consolidado
      collector.record({
        type: 'playback_started',
        slot: 1,
        sourceCategory: 'hls_m3u8',
        deliveryMode: 'direct',
        durationMs: 310,
      });
      expect(transportSpy).toHaveBeenCalledTimes(1);
      expect(transportSpy.mock.calls[0][0]).toHaveLength(3);

      collector.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }

    // Limite do buffer em memória no servidor
    for (let i = 0; i < MAX_SERVER_DIAGNOSTIC_EVENTS + 40; i += 1) {
      recordDiagnosticEventsBatch([
        {
          type: 'buffering',
          timestamp: Date.now() + i,
          sessionId: `s_load_${Math.floor(i / 10)}`,
          slot: 1,
          sourceCategory: 'hls_m3u8',
          deliveryMode: 'direct',
        },
      ]);
    }
    const snapshot = getPlaybackDiagnosticsSnapshot();
    expect(snapshot.retainedEventsCount).toBe(MAX_SERVER_DIAGNOSTIC_EVENTS);

    // Integração administrativa exige sessão autenticada e preserva stream-proxy.ts
    const serverFnsSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/server-fns.ts'),
      'utf8'
    );
    expect(serverFnsSource).toMatch(/adminGetPlaybackDiagnosticsFn[\s\S]*requireAdminSession\(\)/);
    expect(serverFnsSource).toMatch(/adminClearPlaybackDiagnosticsFn[\s\S]*requireAdminSession\(\)/);

    const playerSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/EpisodePlayer.tsx'),
      'utf8'
    );
    expect(playerSource).toContain('createPlaybackDiagnosticsCollector');
    expect(playerSource).toContain('enableWorker: true');
  });
});
