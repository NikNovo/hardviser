import { useEffect, useRef } from 'react';

const FOCUSABLE = ':is(button, input, select, textarea):not(:disabled):not([tabindex="-1"]), :is(a[href], summary, [tabindex]):not([tabindex="-1"])';
const visible = element => element?.isConnected && !element.matches(':disabled') && element.getClientRects().length && !element.closest('[inert], [aria-hidden="true"]') && getComputedStyle(element).visibility !== 'hidden';

export default function useDialogFocus({ active, dialogRef, onClose, initialFocusRef }) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!active || !dialog) return undefined;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const isolated = [];
    // Isolate siblings along the ancestor path, including inline drawers.
    for (let node = dialog; node && node !== document.body; node = node.parentElement) {
      for (const sibling of node.parentElement?.children || []) {
        if (sibling !== node && !sibling.inert && !sibling.hasAttribute('data-dialog-backdrop') && !['SCRIPT', 'STYLE', 'LINK'].includes(sibling.tagName)) {
          sibling.inert = true;
          isolated.push(sibling);
        }
      }
    }
    document.body.style.overflow = 'hidden';
    const items = () => [...dialog.querySelectorAll(FOCUSABLE)].filter(visible);
    const initialTarget = initialFocusRef?.current;
    const target = visible(initialTarget) ? initialTarget : items()[0] || dialog;
    target.focus({ preventScroll: true });
    function keydown(event) {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close.current?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = items();
      const first = controls[0];
      const last = controls.at(-1);
      if (!first) { event.preventDefault(); dialog.focus(); return; }
      if (!dialog.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    }
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      for (const sibling of isolated) sibling.inert = false;
      document.body.style.overflow = previousOverflow;
      let target = visible(previousFocus) ? previousFocus : document.getElementById(previousFocus.id);
      if (!visible(target) && previousFocus.dataset.focusFallback) {
        target = document.getElementById(previousFocus.dataset.focusFallback);
      }
      if (!visible(target)) {
        const controlledId = previousFocus.getAttribute('aria-controls');
        target = controlledId && [...document.querySelectorAll('[aria-controls]')]
          .find(element => element.getAttribute('aria-controls') === controlledId && visible(element));
      }
      if (visible(target)) target.focus({ preventScroll: true });
    };
  }, [active, dialogRef, initialFocusRef]);
}
