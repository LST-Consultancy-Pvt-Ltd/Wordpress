import { forwardRef } from "react";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { useRole } from "../../hooks/useRole";
import { requiresRoleMessage } from "../../lib/roles";

/**
 * A Button that is never "dead": when the user's role, a missing bridge
 * capability, or any other precondition blocks it, it renders disabled with a
 * tooltip (and an accessible description) that says why.
 *
 * Props:
 *   minRole     viewer|editor|deployer|admin
 *   blocked     string|false — extra precondition message (e.g. capability off)
 *   hideIfRole  hide entirely instead of disabling when the role is missing
 */
const GatedButton = forwardRef(function GatedButton(
  { minRole, blocked, hideIfRole = false, disabled, children, ...props },
  ref
) {
  const { can } = useRole();
  const roleOk = can(minRole);
  if (!roleOk && hideIfRole) return null;

  const reason = !roleOk ? requiresRoleMessage(minRole) : blocked || null;
  if (!reason) {
    return (
      <Button ref={ref} disabled={disabled} {...props}>
        {children}
      </Button>
    );
  }

  const testId = props["data-testid"];
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Disabled buttons swallow pointer events; the wrapper keeps the tooltip reachable by mouse and keyboard. */}
          <span tabIndex={0} className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" data-testid={testId ? `${testId}-gate` : undefined} aria-label={typeof children === "string" ? `${children} (unavailable: ${reason})` : undefined}>
            <Button ref={ref} {...props} disabled aria-disabled="true" title={reason}>
              {children}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

export default GatedButton;
