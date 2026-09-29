import { useEffect, useId, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

/**
 * Confirmation dialog with an optional typed-confirmation barrier.
 *
 * - `confirmText`: when set, the user must type it exactly (case-sensitive)
 *   before the action button enables. Used for production applies,
 *   deployments, rollbacks, restores, credential revocation and write
 *   enablement, where the backend requires `{"confirm": "<site name>"}`.
 * - `reasonLabel`: when set, a reason textarea is shown (required if
 *   `reasonRequired`), passed to `onConfirm({typed, reason})`.
 * - `onConfirm` may return a promise; the dialog stays open while it runs and
 *   closes on success. Errors are left to the caller to report.
 */
export default function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText,
  confirmLabel = "Confirm",
  destructive = false,
  reasonLabel,
  reasonRequired = false,
  onConfirm,
  children,
  testId = "confirm-dialog",
}) {
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const typedId = useId();
  const reasonId = useId();

  useEffect(() => {
    if (open) {
      setTyped("");
      setReason("");
      setBusy(false);
    }
  }, [open]);

  const typedOk = !confirmText || typed === confirmText;
  const reasonOk = !reasonRequired || reason.trim().length > 0;
  const ready = typedOk && reasonOk && !busy;

  const run = async (e) => {
    e?.preventDefault?.();
    if (!ready) return;
    setBusy(true);
    try {
      await onConfirm?.({ typed, reason: reason.trim() });
      onOpenChange(false);
    } catch {
      // Caller reports the error; keep the dialog open so the user can retry.
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <AlertDialogContent
        data-testid={testId}
        onOpenAutoFocus={(e) => {
          if (inputRef.current) {
            e.preventDefault();
            inputRef.current.focus();
          }
        }}
      >
        <form onSubmit={run} className="space-y-4">
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            {description ? <AlertDialogDescription asChild><div>{description}</div></AlertDialogDescription> : null}
          </AlertDialogHeader>
          {children}
          {reasonLabel && (
            <div className="space-y-1.5">
              <Label htmlFor={reasonId}>
                {reasonLabel}
                {reasonRequired ? <span aria-hidden="true"> *</span> : null}
              </Label>
              <Textarea
                id={reasonId}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required={reasonRequired}
                rows={2}
                data-testid={`${testId}-reason`}
                ref={confirmText ? undefined : inputRef}
              />
            </div>
          )}
          {confirmText && (
            <div className="space-y-1.5">
              <Label htmlFor={typedId}>
                Type <strong className="font-mono">{confirmText}</strong> to confirm
              </Label>
              <Input
                id={typedId}
                ref={inputRef}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={typed.length > 0 && !typedOk}
                data-testid={`${testId}-input`}
              />
              {typed.length > 0 && !typedOk && (
                <p className="text-xs text-red-500" role="alert">Doesn't match (case-sensitive).</p>
              )}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={busy}>Cancel</AlertDialogCancel>
            <Button
              type="submit"
              variant={destructive ? "destructive" : "default"}
              disabled={!ready}
              data-testid={`${testId}-confirm`}
            >
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              {confirmLabel}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
