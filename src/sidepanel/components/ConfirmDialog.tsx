import { useEffect, useRef } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ open, title, description, confirmLabel, cancelLabel = "取消", destructive = false, busy = false, onConfirm, onCancel }: ConfirmDialogProps): JSX.Element | null {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) cancelRef.current?.focus(); }, [open]);
  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description">
        <h2 id="confirm-title">{title}</h2>
        <p id="confirm-description">{description}</p>
        <div className="dialog__actions">
          <button ref={cancelRef} type="button" className="button button--quiet" disabled={busy} onClick={onCancel}>{cancelLabel}</button>
          <button type="button" className={`button ${destructive ? "button--danger" : "button--primary"}`} disabled={busy} onClick={onConfirm}>{busy ? "处理中…" : confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}
