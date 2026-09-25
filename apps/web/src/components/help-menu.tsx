import { BookOpenIcon, ExternalLinkIcon } from "lucide-react";

import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { documentationLinkFromClientConfig } from "@/lib/documentation-link";
import type { ClientConfig } from "@/types";

/**
 * The account menu's Help section. It renders nothing when the deployment
 * publishes no documentation link (see documentationLinkFromClientConfig).
 * The always-loaded rail footer imports it lazily to keep it out of the
 * direct-session bundle graph.
 */
export function HelpMenu({
  documentationUrl,
  itemClassName,
}: {
  documentationUrl: ClientConfig["documentationUrl"];
  itemClassName?: string;
}) {
  const href = documentationLinkFromClientConfig({ documentationUrl });
  if (!href) return null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-xs font-normal text-fg-muted">Help</DropdownMenuLabel>
      <DropdownMenuItem asChild className={itemClassName}>
        <a href={href} target="_blank" rel="noopener noreferrer">
          <BookOpenIcon className="size-4" />
          Documentation
          <ExternalLinkIcon className="ml-auto size-3.5" aria-hidden="true" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  );
}
