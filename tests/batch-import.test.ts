import { describe, expect, it } from 'vitest';
import {
  BATCH_ITEM_DELAY_MS,
  type BatchImportJobState,
  type BatchItemReport,
  computeBatchTotals,
  type EpisodeSlotRecord,
  hasPendingBatchResume,
  loadBatchJobState,
  parseBatchInputLines,
  planEpisodeSlotInsertion,
  runBatchSequence,
  saveBatchJobState,
  type StorageLike,
  validateBatchIframeItem,
} from '@/lib/batch-import';
import { processBatchItemServer } from '@/lib/server-fns';

const passSafeUrl = async (raw: string) => new URL(raw);

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

describe('parseBatchInputLines', () => {
  it('ignora vazias e comentários # preservando número da linha e registrando erros de formato sem interromper', () => {
    const input = [
      '# Comentário inicial',
      '',
      'ep01 ; https://anitube22.vip/playerricas.php?id=1',
      'ep02 ; https://allappinc.com/embed/2 ; iframe',
      'linha_sem_ponto_e_virgula',
      'ep03 ; https://anitube.biz/player.php ; invalido',
      '  # comentário indentado',
      'ep04 ; https://animesdigital.org/embed/4 ; auto',
    ].join('\n');

    const items = parseBatchInputLines(input);
    expect(items).toHaveLength(5);
    expect(items[0]).toMatchObject({
      lineNumber: 3,
      episodeId: 'ep01',
      url: 'https://anitube22.vip/playerricas.php?id=1',
      explicitKind: null,
      parseError: null,
    });
    expect(items[1]).toMatchObject({
      lineNumber: 4,
      episodeId: 'ep02',
      explicitKind: 'iframe',
      parseError: null,
    });
    expect(items[2].lineNumber).toBe(5);
    expect(items[2].parseError).toContain('Formato inválido');
    expect(items[3].lineNumber).toBe(6);
    expect(items[3].parseError).toContain('Kind inválido');
    expect(items[4].lineNumber).toBe(8);
    expect(items[4].explicitKind).toBeNull();
  });
});

describe('validateBatchIframeItem', () => {
  it('aprova host em EMBED_DIRECT_HOSTS por allowlist mesmo quando servidor responde 403 do WAF', async () => {
    const [item] = parseBatchInputLines('ep01 ; https://animesdigital.org/embed/99');
    const res = await validateBatchIframeItem(item, {
      probeDirectHost: async () => ({ status: 403 }),
    });

    expect(res.verdict).toBe('aprovado');
    expect(res.resolvedKind).toBe('iframe');
    expect(res.reason).toContain('403');
  });

  it('valida EMBED_PROXIED_HOSTS via /api/embed e só aprova com 200', async () => {
    const [item] = parseBatchInputLines('ep02 ; https://allappinc.com/embed/ok');

    const okRes = await validateBatchIframeItem(item, {
      embedAssertSafeUrl: passSafeUrl,
      embedFetchImpl: async () =>
        new Response('<html><head></head><body>ok</body></html>', { status: 200 }),
    });
    expect(okRes.verdict).toBe('aprovado');
    expect(okRes.reason).toContain('200');

    const failRes = await validateBatchIframeItem(item, {
      embedAssertSafeUrl: passSafeUrl,
      embedFetchImpl: async () => new Response('Forbidden', { status: 403 }),
    });
    expect(failRes.verdict).toBe('reprovado');
    expect(failRes.reason).toContain('502');
  });

  it('reprova host desconhecido com "host não mapeado" e não-iframe com "não é página de player"', async () => {
    const items = parseBatchInputLines(
      [
        'ep01 ; https://desconhecido.example.com/embed/1',
        'ep02 ; https://cdn.example.com/video/playlist.m3u8',
        'ep03 ; https://allappinc.com/video.mp4 ; mp4',
        'ep04 ; http://allappinc.com/embed/1',
      ].join('\n')
    );

    const r1 = await validateBatchIframeItem(items[0]);
    expect(r1.verdict).toBe('reprovado');
    expect(r1.reason).toBe('host não mapeado');

    const r2 = await validateBatchIframeItem(items[1]);
    expect(r2.verdict).toBe('reprovado');
    expect(r2.reason).toBe('não é página de player');

    const r3 = await validateBatchIframeItem(items[2]);
    expect(r3.verdict).toBe('reprovado');
    expect(r3.reason).toBe('não é página de player');

    const r4 = await validateBatchIframeItem(items[3]);
    expect(r4.verdict).toBe('reprovado');
    expect(r4.reason).toContain('HTTPS');
  });
});

describe('planEpisodeSlotInsertion e processBatchItemServer (slots e deduplicação)', () => {
  const baseEpisode: EpisodeSlotRecord = {
    id: 'ep_1',
    video_url: 'https://anitube22.vip/playerricas.php?id=10',
    video_url_2: 'https://cdn.example.com/ep10.m3u8',
    video_url_3: null,
    video_url_4: null,
    video_url_5: null,
    source_kind: 'iframe',
    source_kind_2: 'hls',
    source_kind_3: null,
    source_kind_4: null,
    source_kind_5: null,
  };

  it('preenche o primeiro slot vazio sem sobrescrever slots ocupados', () => {
    const plan = planEpisodeSlotInsertion(
      baseEpisode,
      'https://allappinc.com/embed/ep10',
      'iframe'
    );
    expect(plan.action).toBe('save');
    if (plan.action === 'save') {
      expect(plan.slot).toBe(3);
      expect(plan.patch).toEqual({
        video_url_3: 'https://allappinc.com/embed/ep10',
        source_kind_3: 'iframe',
      });
    }
  });

  it('deduplica URL repetida no mesmo episódio', () => {
    const plan = planEpisodeSlotInsertion(
      baseEpisode,
      'https://anitube22.vip/playerricas.php?id=10',
      'iframe'
    );
    expect(plan.action).toBe('skip');
    expect(plan.reason).toContain('duplicada');
  });

  it('skipa quando todos os 5 slots já estão ocupados e nunca sobrescreve', () => {
    const fullEpisode: EpisodeSlotRecord = {
      ...baseEpisode,
      video_url_3: 'https://anitube.biz/e/3',
      video_url_4: 'https://anitube.zip/e/4',
      video_url_5: 'https://animesdigital.org/e/5',
      source_kind_3: 'iframe',
      source_kind_4: 'iframe',
      source_kind_5: 'iframe',
    };
    const plan = planEpisodeSlotInsertion(
      fullEpisode,
      'https://anitube.ninja/e/6',
      'iframe'
    );
    expect(plan.action).toBe('skip');
    expect(plan.reason).toContain('5 slots');
  });
});

describe('execução em série (100 itens, 400ms) e "Continuar de onde parou" após reload', () => {
  it('processa lote de 100 itens estritamente em série (concorrência máxima = 1) com intervalo de 400ms e relatório completo', async () => {
    const lines = Array.from(
      { length: 100 },
      (_, idx) => `ep_${idx + 1} ; https://allappinc.com/embed/${idx + 1}`
    ).join('\n');
    const items = parseBatchInputLines(lines);
    expect(items).toHaveLength(100);

    let activeCount = 0;
    let maxConcurrent = 0;
    const recordedDelays: number[] = [];
    const results: BatchItemReport[] = [];

    const store = new Map<string, EpisodeSlotRecord>();
    for (const item of items) {
      store.set(item.episodeId, {
        id: item.episodeId,
        video_url: 'https://anitube.biz/existing',
        video_url_2: null,
        video_url_3: null,
        video_url_4: null,
        video_url_5: null,
        source_kind: 'iframe',
        source_kind_2: null,
        source_kind_3: null,
        source_kind_4: null,
        source_kind_5: null,
      });
    }

    const outcome = await runBatchSequence({
      items,
      startIndex: 0,
      delayMs: BATCH_ITEM_DELAY_MS,
      sleepFn: async (ms) => {
        recordedDelays.push(ms);
      },
      processItem: async (item) => {
        activeCount += 1;
        if (activeCount > maxConcurrent) {
          maxConcurrent = activeCount;
        }
        try {
          return await processBatchItemServer(
            { ...item, save: true },
            {
              saveSource: async (episodeId, normalizedUrl) => {
                const ep = store.get(episodeId);
                if (!ep) {
                  return { saved: false, slot: null, reason: 'Episódio não encontrado.' };
                }
                const plan = planEpisodeSlotInsertion(ep, normalizedUrl, 'iframe');
                if (plan.action === 'skip') {
                  return { saved: false, slot: null, reason: plan.reason };
                }
                store.set(episodeId, { ...ep, ...plan.patch });
                return { saved: true, slot: plan.slot, reason: plan.reason };
              },
            }
          );
        } finally {
          activeCount -= 1;
        }
      },
      onItemComplete: (idx, report) => {
        results[idx] = report;
      },
    });

    expect(maxConcurrent).toBe(1);
    expect(recordedDelays).toHaveLength(99);
    expect(recordedDelays.every((d) => d === 400)).toBe(true);
    expect(outcome.completed).toBe(true);
    expect(outcome.lastProcessedIndex).toBe(99);

    const totals = computeBatchTotals(items.length, results);
    expect(totals).toEqual({
      total: 100,
      processed: 100,
      aprovados: 100,
      reprovados: 0,
      salvos: 100,
    });
    expect(store.get('ep_100')?.video_url_2).toBe(
      'https://allappinc.com/embed/100'
    );
  });

  it('persiste estado no storage e retoma no índice exato via "Continuar de onde parou" após reload', async () => {
    const storage = createMemoryStorage();
    const rawInput = [
      'ep1 ; https://allappinc.com/embed/1',
      'ep2 ; https://allappinc.com/embed/2',
      'ep3 ; https://host-desconhecido.test/e/3',
      'ep4 ; https://animesdigital.org/embed/4',
      'ep5 ; https://allappinc.com/embed/5',
    ].join('\n');
    const items = parseBatchInputLines(rawInput);

    let job: BatchImportJobState = {
      id: 'job_resume_test',
      rawInput,
      mode: 'validate',
      items,
      lastProcessedIndex: -1,
      results: [],
      status: 'running',
      updatedAt: new Date().toISOString(),
    };

    const processedIndicesRun1: number[] = [];

    // Interrompe logo após processar o índice 2 (3ª linha)
    await runBatchSequence({
      items,
      startIndex: 0,
      delayMs: 0,
      shouldStop: () => job.lastProcessedIndex >= 2,
      processItem: async (item, idx) => {
        processedIndicesRun1.push(idx);
        return await processBatchItemServer({ ...item, save: false });
      },
      onItemComplete: (idx, report) => {
        const nextResults = [...job.results];
        nextResults[idx] = report;
        job = {
          ...job,
          lastProcessedIndex: idx,
          results: nextResults,
        };
        saveBatchJobState(job, storage);
      },
    });

    expect(processedIndicesRun1).toEqual([0, 1, 2]);

    // Simula reload da página carregando do storage
    const reloaded = loadBatchJobState(storage);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.status).toBe('paused');
    expect(reloaded?.lastProcessedIndex).toBe(2);
    expect(hasPendingBatchResume(reloaded)).toBe(true);

    // Retoma a partir de lastProcessedIndex + 1 (= 3)
    const processedIndicesRun2: number[] = [];
    let resumedJob = reloaded!;

    await runBatchSequence({
      items: resumedJob.items,
      startIndex: resumedJob.lastProcessedIndex + 1,
      delayMs: 0,
      processItem: async (item, idx) => {
        processedIndicesRun2.push(idx);
        return await processBatchItemServer({ ...item, save: false });
      },
      onItemComplete: (idx, report) => {
        const nextResults = [...resumedJob.results];
        nextResults[idx] = report;
        resumedJob = {
          ...resumedJob,
          lastProcessedIndex: idx,
          results: nextResults,
          status: idx >= resumedJob.items.length - 1 ? 'completed' : 'running',
        };
        saveBatchJobState(resumedJob, storage);
      },
    });

    expect(processedIndicesRun2).toEqual([3, 4]);
    expect(resumedJob.status).toBe('completed');
    expect(resumedJob.results).toHaveLength(5);
    expect(computeBatchTotals(resumedJob.items.length, resumedJob.results)).toEqual({
      total: 5,
      processed: 5,
      aprovados: 4,
      reprovados: 1,
      salvos: 0,
    });
  });
});
