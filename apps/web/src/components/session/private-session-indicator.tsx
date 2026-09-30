import { LockIcon } from "lucide-react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/*
 * Chats in a Personal workspace are private to its owner (docs/organization-
 * tenancy.md): organization owners and admins get no access to another
 * member's Personal workspace, and billing readers see only its usage amounts
 * on Billing & usage, never the chats. These say that, calmly and read-only.
 */

export const PRIVATE_SESSION_EXPLANATION =
  "Only you can see this chat. Organization admins can't open it; billing shows only usage amounts.";

/** The session header's read-only mark for a chat in a Personal workspace. */
export function PrivateSessionIndicator() {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            aria-label={`Private. ${PRIVATE_SESSION_EXPLANATION}`}
            className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 text-2xs text-fg-muted focus-visible:outline-2 focus-visible:outline-ring/55"
          >
            <LockIcon aria-hidden="true" className="size-3 shrink-0" />
            <span className="hidden sm:inline">Private</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-64">
          {PRIVATE_SESSION_EXPLANATION}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
