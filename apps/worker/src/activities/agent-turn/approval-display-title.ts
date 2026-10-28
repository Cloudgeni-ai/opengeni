import { toolReviewAction, type ToolReviewContext } from "@opengeni/contracts";

const GMAIL_PROVIDER_DOMAIN = "gmailmcp.googleapis.com";

/**
 * Give a connector tool's pending approval the same plain title its review
 * card shows ("Update 3 messages", "Draft an email"), so surfaces that only
 * read the event (the inbox, phone and desktop notifications, embeds) don't
 * fall back to the raw tool name. A title the tool or an earlier step already
 * set is kept. Presentation only: the executable call is never changed.
 */
export function withApprovalDisplayTitle(approval: unknown): unknown {
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) return approval;
  const item = approval as Record<string, unknown>;
  const display =
    item.display && typeof item.display === "object" && !Array.isArray(item.display)
      ? (item.display as Record<string, unknown>)
      : null;
  if (!display || typeof display.toolName !== "string" || !display.toolName) return approval;
  if (typeof display.title === "string" && display.title.trim()) return approval;
  const raw =
    item.rawItem && typeof item.rawItem === "object" && !Array.isArray(item.rawItem)
      ? (item.rawItem as Record<string, unknown>)
      : {};
  const context: ToolReviewContext = {
    kind:
      typeof display.providerDomain === "string" &&
      display.providerDomain.toLowerCase() === GMAIL_PROVIDER_DOMAIN
        ? "gmail"
        : "generic",
  };
  let title: string;
  try {
    title = toolReviewAction(display.toolName, item.arguments ?? raw.arguments, context).title;
  } catch {
    return approval;
  }
  if (!title.trim()) return approval;
  return { ...item, display: { ...display, title: title.slice(0, 512) } };
}
