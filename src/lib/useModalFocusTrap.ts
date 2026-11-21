import { useEffect, useRef, useState, type RefObject } from 'react';
import { setGlobalScrollLock } from './motionRuntime';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export interface UseModalFocusTrapOptions<
  TContainer extends HTMLElement = HTMLDivElement,
  TInitialFocus extends HTMLElement = HTMLElement,
> {
  open: boolean;
  onClose: () => void;
  initialFocusRef?: RefObject<TInitialFocus | null>;
  closeDurationMs?: number;
  restoreFocus?: boolean;
  lockScroll?: boolean;
}

export interface UseModalFocusTrapResult<TContainer extends HTMLElement = HTMLDivElement> {
  mounted: boolean;
  visible: boolean;
  containerRef: RefObject<TContainer | null>;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isElementFocusable(el: HTMLElement): boolean {
  if (el.hasAttribute('disabled') || el.getAttribute('aria-hidden') === 'true') {
    return false;
  }
  if (el.closest('[hidden], [inert], [aria-hidden="true"]')) {
    return false;
  }
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    isElementFocusable,
  );
}

/**
 * Accessible animated modal & drawer hook:
 * - Coordinates enter/exit states (`mounted` vs `visible`) so CSS opacity/transform exit smoothly.
 * - Traps `Tab` / `Shift+Tab` inside `containerRef` focusable descendants.
 * - Closes on `Escape`, locks background scroll via `setGlobalScrollLock`, and restores prior focus on close.
 */
export function useModalFocusTrap<
  TContainer extends HTMLElement = HTMLDivElement,
  TInitialFocus extends HTMLElement = HTMLElement,
>({
  open,
  onClose,
  initialFocusRef,
  closeDurationMs = 220,
  restoreFocus = true,
  lockScroll = true,
}: UseModalFocusTrapOptions<TContainer, TInitialFocus>): UseModalFocusTrapResult<TContainer> {
  const [mounted, setMounted] = useState<boolean>(open);
  const [visible, setVisible] = useState<boolean>(false);

  const containerRef = useRef<TContainer | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef<boolean>(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // 1. Enter/exit lifecycle + focus save/restore
  useEffect(() => {
    if (open) {
      if (!wasOpenRef.current && typeof document !== 'undefined') {
        previousFocusRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        wasOpenRef.current = true;
      }

      setMounted(true);

      if (prefersReducedMotion()) {
        setVisible(true);
        return;
      }

      let raf1 = 0;
      let raf2 = 0;
      raf1 = window.requestAnimationFrame(() => {
        raf2 = window.requestAnimationFrame(() => {
          setVisible(true);
        });
      });

      return () => {
        window.cancelAnimationFrame(raf1);
        window.cancelAnimationFrame(raf2);
      };
    }

    setVisible(false);

    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      const target = previousFocusRef.current;
      previousFocusRef.current = null;
      if (restoreFocus && target && target.isConnected) {
        target.focus({ preventScroll: true });
      }
    }

    if (!mounted) return;

    const delay = prefersReducedMotion() ? 0 : Math.max(0, closeDurationMs);
    if (delay === 0) {
      setMounted(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setMounted(false);
    }, delay);

    return () => {
      window.clearTimeout(timer);
    };
  }, [open, mounted, closeDurationMs, restoreFocus]);

  // 2. Restore focus if unmounted abruptly while still open
  useEffect(() => {
    return () => {
      if (wasOpenRef.current) {
        wasOpenRef.current = false;
        const target = previousFocusRef.current;
        previousFocusRef.current = null;
        if (restoreFocus && target && target.isConnected) {
          target.focus({ preventScroll: true });
        }
      }
    };
  }, [restoreFocus]);

  // 3. Initial focus placement upon opening
  useEffect(() => {
    if (!open || !mounted) return;

    const rafId = window.requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) return;

      const preferred = initialFocusRef?.current;
      if (preferred && container.contains(preferred) && isElementFocusable(preferred)) {
        preferred.focus({ preventScroll: true });
        return;
      }

      if (
        document.activeElement instanceof HTMLElement &&
        document.activeElement !== container &&
        container.contains(document.activeElement) &&
        isElementFocusable(document.activeElement)
      ) {
        return;
      }

      const autoFocusTarget = container.querySelector<HTMLElement>('[autofocus]');
      if (autoFocusTarget && isElementFocusable(autoFocusTarget)) {
        autoFocusTarget.focus({ preventScroll: true });
        return;
      }

      const focusables = getFocusableElements(container);
      if (focusables.length > 0) {
        focusables[0].focus({ preventScroll: true });
        return;
      }

      if (!container.hasAttribute('tabindex')) {
        container.setAttribute('tabindex', '-1');
      }
      container.focus({ preventScroll: true });
    });

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [open, mounted, initialFocusRef]);

  // 4. Escape handling + Tab / Shift+Tab focus trap
  useEffect(() => {
    if (!open || !mounted) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== 'Tab') return;

      const container = containerRef.current;
      if (!container) return;

      const focusables = getFocusableElements(container);
      if (focusables.length === 0) {
        event.preventDefault();
        if (!container.hasAttribute('tabindex')) {
          container.setAttribute('tabindex', '-1');
        }
        container.focus({ preventScroll: true });
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;

      if (!active || !container.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
        return;
      }

      if (focusables.length === 1) {
        event.preventDefault();
        first.focus({ preventScroll: true });
        return;
      }

      if (event.shiftKey) {
        if (active === first || active === container) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, mounted]);

  // 5. Background scroll lock while mounted
  useEffect(() => {
    if (!lockScroll || !mounted) return;
    setGlobalScrollLock(true);
    return () => {
      setGlobalScrollLock(false);
    };
  }, [lockScroll, mounted]);

  return {
    mounted,
    visible,
    containerRef,
  };
}
