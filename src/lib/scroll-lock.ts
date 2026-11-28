export interface ScrollLockTargetElement {
  clientHeight: number;
  clientWidth: number;
  scrollHeight: number;
  scrollWidth: number;
  style: {
    overflow: string;
    overscrollBehavior: string;
    position?: string;
    top?: string;
    left?: string;
    width?: string;
    paddingRight?: string;
    boxSizing?: string;
  };
}

export interface ScrollLockEnvironment {
  innerWidth: number;
  scrollX: number;
  scrollY: number;
  scrollTo: (x: number, y: number) => void;
  documentElement: ScrollLockTargetElement;
  body: ScrollLockTargetElement;
  getComputedStyle: (el: unknown) => {
    paddingRight: string;
    overflowY?: string;
  };
  addTouchMoveListener: (listener: (event: TouchMoveLikeEvent) => void) => void;
  removeTouchMoveListener: (listener: (event: TouchMoveLikeEvent) => void) => void;
}

export interface TouchMoveLikeEvent {
  target: unknown;
  cancelable?: boolean;
  touches?: { length: number };
  preventDefault: () => void;
}

export interface BodyScrollLockOptions {
  getAllowedContainer?: () => HTMLElement | null;
  env?: ScrollLockEnvironment;
}

interface ActiveLockState {
  count: number;
  scrollX: number;
  scrollY: number;
  prevHtmlStyles: {
    overflow: string;
    overscrollBehavior: string;
  };
  prevBodyStyles: {
    position: string;
    top: string;
    left: string;
    width: string;
    overflow: string;
    overscrollBehavior: string;
    paddingRight: string;
    boxSizing: string;
  };
  getAllowedContainer?: () => HTMLElement | null;
  touchMoveListener: (event: TouchMoveLikeEvent) => void;
  env: ScrollLockEnvironment;
}

let globalActiveLock: ActiveLockState | null = null;

function createBrowserEnvironment(): ScrollLockEnvironment | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return null;
  }
  if (!document.documentElement || !document.body) {
    return null;
  }

  return {
    get innerWidth() {
      return window.innerWidth;
    },
    get scrollX() {
      return window.scrollX || window.pageXOffset || document.documentElement.scrollLeft || 0;
    },
    get scrollY() {
      return window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
    },
    scrollTo: (x: number, y: number) => {
      window.scrollTo(x, y);
    },
    documentElement: document.documentElement,
    body: document.body,
    getComputedStyle: (el: unknown) => window.getComputedStyle(el as Element),
    addTouchMoveListener: (listener) => {
      document.addEventListener('touchmove', listener as EventListener, { passive: false });
    },
    removeTouchMoveListener: (listener) => {
      document.removeEventListener('touchmove', listener as EventListener);
    },
  };
}

function isEditableTouchTarget(target: unknown): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) {
    return false;
  }
  return Boolean(target.closest('input, textarea, select'));
}

export function hasScrollableOverflowWithinContainer(
  target: unknown,
  container: HTMLElement | null,
  getComputedStyleFn: (el: unknown) => { overflowY?: string } = (el) =>
    typeof window !== 'undefined' ? window.getComputedStyle(el as Element) : {}
): boolean {
  if (!container || typeof Node === 'undefined' || !(target instanceof Node)) {
    return false;
  }
  if (!container.contains(target)) {
    return false;
  }

  let current: Node | null = target;
  while (current) {
    if (current instanceof HTMLElement) {
      const style = getComputedStyleFn(current);
      const overflowY = style.overflowY ?? '';
      const allowsYScroll =
        overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
      if (allowsYScroll && current.scrollHeight > current.clientHeight + 1) {
        return true;
      }
      if (current === container) {
        break;
      }
    }
    current = current.parentNode;
  }

  return false;
}

export function shouldAllowTouchMoveInScrollLock(
  event: TouchMoveLikeEvent,
  container: HTMLElement | null,
  getComputedStyleFn?: (el: unknown) => { overflowY?: string }
): boolean {
  if (event.touches && event.touches.length > 1) {
    return true;
  }
  if (!container) {
    return false;
  }
  if (typeof Node !== 'undefined' && event.target instanceof Node && !container.contains(event.target)) {
    return false;
  }
  if (isEditableTouchTarget(event.target)) {
    return true;
  }
  return hasScrollableOverflowWithinContainer(event.target, container, getComputedStyleFn);
}

/**
 * Locks background page scrolling (desktop wheel, Android touchmove, iOS Safari viewport)
 * while preserving exact scroll coordinates and compensating desktop scrollbar width.
 * Returns an idempotent cleanup function that restores original styles and scroll position.
 */
export function acquireBodyScrollLock(options: BodyScrollLockOptions = {}): () => void {
  const env = options.env ?? createBrowserEnvironment();
  if (!env) {
    return () => {};
  }

  if (globalActiveLock && globalActiveLock.env === env) {
    globalActiveLock.count += 1;
    if (options.getAllowedContainer) {
      globalActiveLock.getAllowedContainer = options.getAllowedContainer;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGlobalLock();
    };
  }

  const scrollX = env.scrollX;
  const scrollY = env.scrollY;
  const scrollbarWidth = Math.max(0, env.innerWidth - env.documentElement.clientWidth);

  const prevHtmlStyles = {
    overflow: env.documentElement.style.overflow,
    overscrollBehavior: env.documentElement.style.overscrollBehavior,
  };

  const prevBodyStyles = {
    position: env.body.style.position ?? '',
    top: env.body.style.top ?? '',
    left: env.body.style.left ?? '',
    width: env.body.style.width ?? '',
    overflow: env.body.style.overflow,
    overscrollBehavior: env.body.style.overscrollBehavior,
    paddingRight: env.body.style.paddingRight ?? '',
    boxSizing: env.body.style.boxSizing ?? '',
  };

  const computedBodyPaddingRight = Number.parseFloat(env.getComputedStyle(env.body).paddingRight) || 0;

  env.documentElement.style.overflow = 'hidden';
  env.documentElement.style.overscrollBehavior = 'none';

  env.body.style.overflow = 'hidden';
  env.body.style.overscrollBehavior = 'none';
  env.body.style.position = 'fixed';
  env.body.style.top = scrollY === 0 ? '0px' : `-${scrollY}px`;
  env.body.style.left = scrollX === 0 ? '0px' : `-${scrollX}px`;
  env.body.style.width = '100%';
  env.body.style.boxSizing = 'border-box';
  if (scrollbarWidth > 0) {
    env.body.style.paddingRight = `${computedBodyPaddingRight + scrollbarWidth}px`;
  }

  const lockState: ActiveLockState = {
    count: 1,
    scrollX,
    scrollY,
    prevHtmlStyles,
    prevBodyStyles,
    getAllowedContainer: options.getAllowedContainer,
    env,
    touchMoveListener: (event: TouchMoveLikeEvent) => {
      const container = lockState.getAllowedContainer?.() ?? null;
      const allowed = shouldAllowTouchMoveInScrollLock(event, container, env.getComputedStyle);
      if (!allowed && event.cancelable !== false) {
        event.preventDefault();
      }
    },
  };

  globalActiveLock = lockState;
  env.addTouchMoveListener(lockState.touchMoveListener);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGlobalLock();
  };
}

function releaseGlobalLock() {
  if (!globalActiveLock) return;

  globalActiveLock.count -= 1;
  if (globalActiveLock.count > 0) {
    return;
  }

  const { env, prevHtmlStyles, prevBodyStyles, scrollX, scrollY, touchMoveListener } =
    globalActiveLock;
  globalActiveLock = null;

  env.removeTouchMoveListener(touchMoveListener);

  env.documentElement.style.overflow = prevHtmlStyles.overflow;
  env.documentElement.style.overscrollBehavior = prevHtmlStyles.overscrollBehavior;

  env.body.style.position = prevBodyStyles.position;
  env.body.style.top = prevBodyStyles.top;
  env.body.style.left = prevBodyStyles.left;
  env.body.style.width = prevBodyStyles.width;
  env.body.style.overflow = prevBodyStyles.overflow;
  env.body.style.overscrollBehavior = prevBodyStyles.overscrollBehavior;
  env.body.style.paddingRight = prevBodyStyles.paddingRight;
  env.body.style.boxSizing = prevBodyStyles.boxSizing;

  env.scrollTo(scrollX, scrollY);
}

export function resetBodyScrollLockForTests(): void {
  if (globalActiveLock) {
    globalActiveLock.count = 1;
    releaseGlobalLock();
  }
}
