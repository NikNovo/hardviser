import { useId, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import useDialogFocus from './useDialogFocus.js';

const visibleFocusTarget = element => element?.isConnected
  && !element.matches(':disabled')
  && element.getClientRects().length
  && !element.closest('[inert], [aria-hidden="true"]')
  && getComputedStyle(element).visibility !== 'hidden';

export default function Modal({
  title,
  onClose,
  children,
  labelId,
  initialFocusRef,
  closeDisabled = false,
  variant = 'default',
  footer = null,
}) {
  const generatedId = useId();
  const headingId = labelId || generatedId;
  const dialog = useRef(null);
  const handleClose = () => { if (!closeDisabled) onClose(); };
  useDialogFocus({ active: true, dialogRef: dialog, onClose: handleClose, initialFocusRef });
  const previousTitle = useRef(title);
  const previousInitialTarget = useRef(initialFocusRef?.current);
  const hasCommitted = useRef(false);
  // Ref targets change at commit even when view/edit headings are identical.
  useLayoutEffect(() => {
    // Let the focus hook capture the opener before moving initial focus.
    if (!hasCommitted.current) {
      hasCommitted.current = true;
      previousTitle.current = title;
      previousInitialTarget.current = initialFocusRef?.current;
      return;
    }
    const activeElement = document.activeElement;
    const focusIsInside = dialog.current.contains(activeElement);
    const initialTarget = initialFocusRef?.current;
    const contentChanged = previousTitle.current !== title
      || previousInitialTarget.current !== initialTarget;
    if (contentChanged && !focusIsInside) {
      const scrollContainer = variant === 'record'
        ? dialog.current.querySelector('.modal-body')
        : dialog.current;
      if (scrollContainer) scrollContainer.scrollTop = 0;
    }
    if ((contentChanged && !focusIsInside)
      || (closeDisabled && (!focusIsInside || activeElement.matches?.(':disabled')))) {
      const focusTarget = contentChanged && !focusIsInside && visibleFocusTarget(initialTarget)
        ? initialTarget
        : dialog.current;
      focusTarget.focus({ preventScroll: true });
    }
    previousTitle.current = title;
    previousInitialTarget.current = initialTarget;
  });
  return createPortal(<div className="modal-backdrop" onMouseDown={event => {
    if (event.target !== event.currentTarget) return;
    // Do not let the native mouse focus change undo dialog focus restoration.
    event.preventDefault();
    handleClose();
  }}>
    <div className={variant === 'record' ? 'modal modal--record' : 'modal'} role="dialog" aria-modal="true" aria-labelledby={headingId} ref={dialog} tabIndex={-1}>
      <div className="modal-header"><h2 id={headingId}>{title}</h2><button type="button" className="button ghost" aria-label="Close" onClick={handleClose} disabled={closeDisabled}><X size={18}/></button></div>
      <div className="modal-body">{children}</div>
      {footer != null && <div className="modal-footer">{footer}</div>}
    </div>
  </div>, document.body);
}
