import Lenis from 'lenis';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

export const HERO_SCROLL_EVENT = 'bro:hero-scroll';

export interface BroHeroScrollDetail {
  progress: number;
}

interface MotionRuntimeState {
  pluginRegistered: boolean;
  lifecycleRegistered: boolean;
  hasRunForCurrentView: boolean;
  active: boolean;
  generation: number;
  lockCount: number;
  lenis: Lenis | null;
  unsubscribeLenisScroll: (() => void) | null;
  tickerCallback: ((time: number) => void) | null;
  gsapCtx: gsap.Context | null;
  reducedMotionQuery: MediaQueryList | null;
  reducedMotionListener: ((event: MediaQueryListEvent) => void) | null;
  heroStageEl: HTMLElement | null;
}

const RUNTIME_STATE_SYMBOL = Symbol.for('bro.motionRuntime.state');

function getRuntimeState(): MotionRuntimeState {
  const host = globalThis as typeof globalThis & {
    [RUNTIME_STATE_SYMBOL]?: MotionRuntimeState;
  };
  if (!host[RUNTIME_STATE_SYMBOL]) {
    host[RUNTIME_STATE_SYMBOL] = {
      pluginRegistered: false,
      lifecycleRegistered: false,
      hasRunForCurrentView: false,
      active: false,
      generation: 0,
      lockCount: 0,
      lenis: null,
      unsubscribeLenisScroll: null,
      tickerCallback: null,
      gsapCtx: null,
      reducedMotionQuery: null,
      reducedMotionListener: null,
      heroStageEl: null,
    };
  }
  return host[RUNTIME_STATE_SYMBOL];
}

function attachReducedMotionListener(state: MotionRuntimeState, query: MediaQueryList): void {
  if (state.reducedMotionListener && state.reducedMotionQuery) {
    state.reducedMotionQuery.removeEventListener('change', state.reducedMotionListener);
  }
  const onMotionPreferenceChange = () => {
    initMotionRuntime();
  };
  state.reducedMotionQuery = query;
  state.reducedMotionListener = onMotionPreferenceChange;
  query.addEventListener('change', onMotionPreferenceChange);
}

function revealUnreachableTriggers(triggers: ScrollTrigger[]): void {
  if (triggers.length === 0) return;
  const maxScroll = ScrollTrigger.maxScroll(window);
  for (const trigger of triggers) {
    if (trigger.progress === 0 && trigger.start > maxScroll) {
      const animation = trigger.animation;
      trigger.kill(false, true);
      animation?.play();
    }
  }
}

/**
 * Pause or resume background Lenis + native viewport scrolling cleanly.
 * Reference-counted so overlapping modals/drawers never unlock prematurely.
 */
export function setGlobalScrollLock(locked: boolean): void {
  if (typeof document === 'undefined') return;
  const state = getRuntimeState();

  if (locked) {
    state.lockCount += 1;
    document.documentElement.classList.add('bro-scroll-locked');
    state.lenis?.stop();
    return;
  }

  state.lockCount = Math.max(0, state.lockCount - 1);
  if (state.lockCount === 0) {
    document.documentElement.classList.remove('bro-scroll-locked');
    state.lenis?.start();
  }
}

/**
 * Expose active Lenis instance (null when uninitialized or reduced motion is enabled).
 */
export function getLenisInstance(): Lenis | null {
  return getRuntimeState().lenis;
}

/**
 * Initialize Lenis smooth-scroll + single-clock GSAP ScrollTrigger orchestration.
 * Safe to invoke repeatedly; tears down any prior instance before initializing.
 */
export function initMotionRuntime(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const state = getRuntimeState();
  teardownMotionRuntime({ preserveLock: true });

  if (!state.pluginRegistered) {
    gsap.registerPlugin(ScrollTrigger);
    state.pluginRegistered = true;
  }

  state.hasRunForCurrentView = true;

  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  attachReducedMotionListener(state, reducedMotionQuery);

  if (reducedMotionQuery.matches) {
    document.documentElement.classList.remove('bro-motion-ready');
    document.documentElement.style.setProperty('--bro-hero-scroll', '0');
    const heroStage = document.querySelector<HTMLElement>('[data-hero-stage]');
    if (heroStage) {
      heroStage.style.setProperty('--bro-hero-scroll', '0');
      state.heroStageEl = heroStage;
    }
    return;
  }

  const runGeneration = ++state.generation;
  state.active = true;

  const lenis = new Lenis({
    lerp: 0.09,
    smoothWheel: true,
    syncTouch: false,
    anchors: true,
    autoRaf: false,
  });
  state.lenis = lenis;

  if (state.lockCount > 0) {
    document.documentElement.classList.add('bro-scroll-locked');
    lenis.stop();
  }

  const onLenisScroll = () => {
    ScrollTrigger.update();
  };
  state.unsubscribeLenisScroll = lenis.on('scroll', onLenisScroll);

  const tickerCallback = (time: number) => {
    state.lenis?.raf(time * 1000);
  };
  state.tickerCallback = tickerCallback;
  gsap.ticker.add(tickerCallback);
  gsap.ticker.lagSmoothing(0);

  document.documentElement.classList.add('bro-motion-ready');

  const revealTriggers: ScrollTrigger[] = [];

  try {
    state.gsapCtx = gsap.context(() => {
      // 1. Scrubbed hero scroll progress (--bro-hero-scroll 0..1 + event)
      const heroStage = document.querySelector<HTMLElement>('[data-hero-stage]');
      state.heroStageEl = heroStage;
      document.documentElement.style.setProperty('--bro-hero-scroll', '0');

      if (heroStage) {
        let lastEmittedProgress = -1;
        const emitHeroProgress = (rawProgress: number) => {
          const progress = Math.min(1, Math.max(0, rawProgress));
          if (Math.abs(progress - lastEmittedProgress) < 0.0005) return;
          lastEmittedProgress = progress;
          const formatted = progress.toFixed(4);
          document.documentElement.style.setProperty('--bro-hero-scroll', formatted);
          heroStage.style.setProperty('--bro-hero-scroll', formatted);
          window.dispatchEvent(
            new CustomEvent<BroHeroScrollDetail>(HERO_SCROLL_EVENT, {
              detail: { progress },
            }),
          );
        };

        emitHeroProgress(0);

        ScrollTrigger.create({
          trigger: heroStage,
          start: 'top top',
          end: 'bottom top',
          scrub: true,
          invalidateOnRefresh: true,
          onUpdate: (self) => emitHeroProgress(self.progress),
          onRefresh: (self) => emitHeroProgress(self.progress),
        });
      }

      // 2. Staggered reveal groups ([data-reveal-group])
      const groupManaged = new Set<HTMLElement>();
      const revealGroups = Array.from(
        document.querySelectorAll<HTMLElement>('[data-reveal-group]'),
      );

      for (const group of revealGroups) {
        const explicitItems = Array.from(
          group.querySelectorAll<HTMLElement>('[data-reveal-item]'),
        );
        const children =
          explicitItems.length > 0
            ? explicitItems
            : Array.from(group.children).filter(
                (el): el is HTMLElement => el instanceof HTMLElement,
              );

        if (children.length === 0) continue;
        for (const child of children) {
          groupManaged.add(child);
        }

        const staggerEach =
          children.length > 1 ? Math.min(0.06, 0.32 / (children.length - 1)) : 0;

        const tween = gsap.fromTo(
          children,
          { opacity: 0.92, y: 16 },
          {
            opacity: 1,
            y: 0,
            duration: 0.55,
            ease: 'power3.out',
            stagger: staggerEach,
            clearProps: 'transform,opacity,willChange',
            scrollTrigger: {
              trigger: group,
              start: 'top 95%',
              once: true,
            },
          },
        );
        if (tween.scrollTrigger) {
          revealTriggers.push(tween.scrollTrigger);
        }
      }

      // 3. Standalone reveals ([data-reveal="fade-up"] or [data-reveal])
      const revealNodes = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-reveal="fade-up"], [data-reveal=""]:not([data-reveal="none"])',
        ),
      ).filter((el) => !groupManaged.has(el));

      for (const el of revealNodes) {
        const tween = gsap.fromTo(
          el,
          { opacity: 0.92, y: 16 },
          {
            opacity: 1,
            y: 0,
            duration: 0.55,
            ease: 'power3.out',
            clearProps: 'transform,opacity,willChange',
            scrollTrigger: {
              trigger: el,
              start: 'top 95%',
              once: true,
            },
          },
        );
        if (tween.scrollTrigger) {
          revealTriggers.push(tween.scrollTrigger);
        }
      }
    });
  } catch {
    teardownMotionRuntime({ preserveLock: true });
    return;
  }

  ScrollTrigger.refresh();
  revealUnreachableTriggers(revealTriggers);

  if (document.fonts?.ready) {
    void document.fonts.ready.then(() => {
      if (state.active && state.generation === runGeneration) {
        ScrollTrigger.refresh();
        revealUnreachableTriggers(revealTriggers);
      }
    });
  }
}

/**
 * Tear down Lenis, GSAP ScrollTriggers, ticker hooks, and per-page listeners cleanly.
 * Automatically invoked on `astro:before-swap` to keep ClientRouter memory-leak free.
 */
export function teardownMotionRuntime(options?: { preserveLock?: boolean }): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const state = getRuntimeState();
  state.generation += 1;
  state.active = false;

  if (state.tickerCallback) {
    gsap.ticker.remove(state.tickerCallback);
    state.tickerCallback = null;
  }
  gsap.ticker.lagSmoothing(500, 33);

  if (state.unsubscribeLenisScroll) {
    state.unsubscribeLenisScroll();
    state.unsubscribeLenisScroll = null;
  }

  if (state.lenis) {
    state.lenis.destroy();
    state.lenis = null;
  }

  if (state.gsapCtx) {
    state.gsapCtx.revert();
    state.gsapCtx = null;
  }

  if (state.reducedMotionQuery && state.reducedMotionListener) {
    state.reducedMotionQuery.removeEventListener('change', state.reducedMotionListener);
  }
  state.reducedMotionQuery = null;
  state.reducedMotionListener = null;

  document.documentElement.classList.remove('bro-motion-ready');
  document.documentElement.style.removeProperty('--bro-hero-scroll');
  if (state.heroStageEl) {
    state.heroStageEl.style.removeProperty('--bro-hero-scroll');
    state.heroStageEl = null;
  }

  if (!options?.preserveLock) {
    state.lockCount = 0;
    document.documentElement.classList.remove('bro-scroll-locked');
  }
}

function handleAstroPageLoad(): void {
  const state = getRuntimeState();
  state.hasRunForCurrentView = true;
  initMotionRuntime();
}

function handleAstroBeforeSwap(): void {
  const state = getRuntimeState();
  state.hasRunForCurrentView = false;
  teardownMotionRuntime();
}

function registerAstroLifecycle(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const state = getRuntimeState();
  if (state.lifecycleRegistered) return;
  state.lifecycleRegistered = true;

  document.addEventListener('astro:page-load', handleAstroPageLoad);
  document.addEventListener('astro:before-swap', handleAstroBeforeSwap);

  // If imported after initial document load / astro:page-load already fired (e.g. deferred island)
  if (document.readyState === 'complete' && !state.hasRunForCurrentView) {
    queueMicrotask(() => {
      const currentState = getRuntimeState();
      if (!currentState.hasRunForCurrentView && !currentState.active) {
        initMotionRuntime();
      }
    });
  }
}

registerAstroLifecycle();
