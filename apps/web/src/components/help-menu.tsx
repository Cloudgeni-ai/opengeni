import { BookOpenIcon, CircleHelpIcon, ExternalLinkIcon, MessageSquareIcon } from "lucide-react";

import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { documentationLinkFromClientConfig } from "@/lib/documentation-link";
import type { ClientConfig } from "@/types";

export type HelpMenuProps = {
  documentationUrl: ClientConfig["documentationUrl"];
  /** Opens the feedback dialog; omit when the person can't send feedback. */
  onSendFeedback?: (() => void) | undefined;
};

/**
 * The account menu's "Help & feedback" row and its submenu: Documentation (when
 * the deployment publishes a link, see documentationLinkFromClientConfig) and
 * Send feedback (when the person may send it). It renders nothing when neither
 * applies. Both account menus import it statically, so opening a menu never
 * waits on or fails with a separately fetched chunk.
 */
export function HelpMenu({ documentationUrl, onSendFeedback }: HelpMenuProps) {
  const href = documentationLinkFromClientConfig({ documentationUrl });
  if (!href && !onSendFeedback) return null;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <CircleHelpIcon />
        Help &amp; feedback
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-52">
        {href ? (
          <DropdownMenuItem asChild>
            <a href={href} target="_blank" rel="noopener noreferrer">
              <BookOpenIcon />
              Documentation
              <ExternalLinkIcon className="ml-auto size-3.5 text-fg-muted" aria-hidden="true" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </DropdownMenuItem>
        ) : null}
        {onSendFeedback ? (
          <DropdownMenuItem onSelect={onSendFeedback}>
            <MessageSquareIcon />
            Send feedback
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
