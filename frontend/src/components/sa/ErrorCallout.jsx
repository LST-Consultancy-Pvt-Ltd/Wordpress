import { AlertTriangle } from "lucide-react";

/** Inline error with optional bridge error code and correlation id. */
export default function ErrorCallout({ title = "Something went wrong", message, code, correlationId, children, testId = "error-callout" }) {
  if (!message && !children) return null;
  return (
    <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm" role="alert" data-testid={testId}>
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className="text-red-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
        <div className="min-w-0 space-y-1">
          <p className="font-medium text-red-500">{title}</p>
          {message && <p className="text-foreground/90 break-words">{message}</p>}
          {(code || correlationId) && (
            <p className="text-xs text-muted-foreground font-mono">
              {code && <>code: {code}</>}
              {code && correlationId && " · "}
              {correlationId && <>correlation id: {correlationId}</>}
            </p>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}
