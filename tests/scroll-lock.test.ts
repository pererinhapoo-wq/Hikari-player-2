import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireBodyScrollLock,
  resetBodyScrollLockForTests,
  type ScrollLockEnvironment,
  type TouchMoveLikeEvent,
} from '@/lib/scroll-lock';

function createMockEnvironment(overrides: Partial<ScrollLockEnvironment> = {}) {
  const scrollToCalls: Array<{ x: number; y: number }> = [];
  const touchMoveListeners: Array<(event: TouchMoveLikeEvent) => void> = [];

  const html = {
    clientHeight: 800,
    clientWidth: 1265,
    scrollHeight: 2600,
    scrollWidth: 1265,
    style: {
      overflow: '',
      overscrollBehavior: '',
    },
  };

  const body = {
    clientHeight: 2600,
    clientWidth: 1265,
    scrollHeight: 2600,
    scrollWidth: 1265,
    style: {
      overflow: '',
      overscrollBehavior: '',
      position: '',
      top: '',
      left: '',
      width: '',
      paddingRight: '',
      boxSizing: '',
    },
  };

  const env: ScrollLockEnvironment = {
    innerWidth: 1280,
    scrollX: 0,
    scrollY: 1240,
    scrollTo: (x, y) => {
      scrollToCalls.push({ x, y });
    },
    documentElement: html,
    body,
    getComputedStyle: () => ({ paddingRight: '0px', overflowY: 'visible' }),
    addTouchMoveListener: (listener) => {
      touchMoveListeners.push(listener);
    },
    removeTouchMoveListener: (listener) => {
      const idx = touchMoveListeners.indexOf(listener);
      if (idx >= 0) touchMoveListeners.splice(idx, 1);
    },
    ...overrides,
  };

  return { env, html, body, scrollToCalls, touchMoveListeners };
}

describe('Bloqueio de rolagem de fundo no modal Tempos da Opening', () => {
  afterEach(() => {
    resetBodyScrollLockForTests();
  });

  it('1 e 3. bloqueia html/body na posição atual e restaura exatamente estilos e scroll ao fechar', () => {
    const { env, html, body, scrollToCalls, touchMoveListeners } = createMockEnvironment({
      innerWidth: 1280,
      scrollX: 12,
      scrollY: 1450,
    });
    html.style.overflow = 'auto';
    body.style.paddingRight = '8px';
    env.getComputedStyle = () => ({ paddingRight: '8px', overflowY: 'visible' });

    const release = acquireBodyScrollLock({ env });

    expect(html.style.overflow).toBe('hidden');
    expect(html.style.overscrollBehavior).toBe('none');
    expect(body.style.overflow).toBe('hidden');
    expect(body.style.overscrollBehavior).toBe('none');
    expect(body.style.position).toBe('fixed');
    expect(body.style.top).toBe('-1450px');
    expect(body.style.left).toBe('-12px');
    expect(body.style.width).toBe('100%');
    // Compensa 15px da barra de rolagem (1280 - 1265) + 8px pré-existentes = 23px
    expect(body.style.paddingRight).toBe('23px');
    expect(touchMoveListeners).toHaveLength(1);

    // Simula fechamento por Cancelar / Salvar / desmontagem
    release();

    expect(html.style.overflow).toBe('auto');
    expect(html.style.overscrollBehavior).toBe('');
    expect(body.style.overflow).toBe('');
    expect(body.style.overscrollBehavior).toBe('');
    expect(body.style.position).toBe('');
    expect(body.style.top).toBe('');
    expect(body.style.left).toBe('');
    expect(body.style.width).toBe('');
    expect(body.style.paddingRight).toBe('8px');
    expect(touchMoveListeners).toHaveLength(0);
    expect(scrollToCalls).toEqual([{ x: 12, y: 1450 }]);
  });

  it('2. bloqueia touchmove no fundo quando fora do contêiner permitido (Android/Safari)', () => {
    const { env, touchMoveListeners } = createMockEnvironment();
    const release = acquireBodyScrollLock({ env });

    expect(touchMoveListeners).toHaveLength(1);
    const preventDefault = vi.fn();

    touchMoveListeners[0]({
      target: null,
      cancelable: true,
      touches: { length: 1 },
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);

    // Permite zoom com dois dedos (pinch)
    const preventDefaultMulti = vi.fn();
    touchMoveListeners[0]({
      target: null,
      cancelable: true,
      touches: { length: 2 },
      preventDefault: preventDefaultMulti,
    });
    expect(preventDefaultMulti).not.toHaveBeenCalled();

    release();
  });

  it('4 e 5. evita listeners duplicados, preserva scrollY original e garante cleanup idempotente', () => {
    const { env, body, scrollToCalls, touchMoveListeners } = createMockEnvironment({
      scrollY: 980,
    });

    const releaseFirst = acquireBodyScrollLock({ env });
    // Simula que window.scrollY virou 0 enquanto body estava fixed
    env.scrollY = 0;
    const releaseSecond = acquireBodyScrollLock({ env });

    expect(touchMoveListeners).toHaveLength(1);
    expect(body.style.top).toBe('-980px');

    // Chamar releaseFirst duas vezes não pode liberar prematuramente nem duplicar scrollTo
    releaseFirst();
    releaseFirst();
    expect(body.style.position).toBe('fixed');
    expect(scrollToCalls).toHaveLength(0);

    // Liberar o segundo lock restaura para 980px
    releaseSecond();
    expect(body.style.position).toBe('');
    expect(touchMoveListeners).toHaveLength(0);
    expect(scrollToCalls).toEqual([{ x: 0, y: 980 }]);
  });

  it('6. confirma integração no admin.tsx com portal, cleanup em unmount e contenção de scroll', () => {
    const adminSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/routes/admin.tsx'),
      'utf8'
    );

    expect(adminSource).toContain('acquireBodyScrollLock');
    expect(adminSource).toContain('createPortal');
    expect(adminSource).toContain('quickOpeningDialogRef');
    expect(adminSource).toContain('overscroll-contain');
    expect(adminSource).toContain('touch-none overscroll-none');
    expect(adminSource).toContain('isQuickOpeningModalOpen');
  });
});
