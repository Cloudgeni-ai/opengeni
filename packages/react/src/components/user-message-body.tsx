import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "../lib/cn";

const FALLBACK_LINE_THRESHOLD = 12;
const FALLBACK_TEXT_THRESHOLD = 900;
const FALLBACK_UNBROKEN_THRESHOLD = 260;

type RestoreDisclosureAnchor = (() => void) | null;

export type UserMessageDisclosureContextValue = {
  expandedByMessageId: Map<string, boolean>;
  beginChange: (
    messageBody: HTMLElement,
    disclosureControl: HTMLElement,
  ) => RestoreDisclosureAnchor;
};

const UserMessageDisclosureContext = createContext<UserMessageDisclosureContextValue | null>(null);

export function UserMessageDisclosureProvider({
  value,
  children,
}: {
  value: UserMessageDisclosureContextValue;
  children: ReactNode;
}) {
  return (
    <UserMessageDisclosureContext.Provider value={value}>
      {children}
    </UserMessageDisclosureContext.Provider>
  );
}

/**
 * Deterministic first-paint fallback for runtimes without layout measurement.
 * Real browsers replace this estimate with the rendered-height decision in the
 * first layout effect. The complete text always remains mounted either way.
 */
export function userMessageLikelyNeedsDisclosure(text: string): boolean {
  const lines = text.split(/\r?\n/);
  return (
    lines.length > FALLBACK_LINE_THRESHOLD ||
    text.length > FALLBACK_TEXT_THRESHOLD ||
    lines.some((line) => line.length > FALLBACK_UNBROKEN_THRESHOLD)
  );
}

export type UserMessageBodyProps = {
  /** Durable timeline item id. Expansion memory is keyed by this value. */
  messageId: string;
  /** Complete source text. Used only for the deterministic measurement fallback. */
  text: string;
  children: ReactNode;
  className?: string | undefined;
};

/**
 * Lossless disclosure boundary for already-sent user-message text.
 *
 * The full rendered subtree always remains in the DOM. A real browser decides
 * whether disclosure is needed from rendered height (including Markdown
 * structure and wrapping); the source-text heuristic is only a deterministic
 * fallback for SSR/test environments without layout. Timeline-owned context
 * remembers expansion per durable message id and preserves the reader's scroll
 * anchor when height changes.
 */
export function UserMessageBody({ messageId, text, children, className }: UserMessageBodyProps) {
  const disclosure = useContext(UserMessageDisclosureContext);
  const [expanded, setExpanded] = useState(
    () => disclosure?.expandedByMessageId.get(messageId) ?? false,
  );
  const [collapsible, setCollapsible] = useState(() => userMessageLikelyNeedsDisclosure(text));
  const rootRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const thresholdRef = useRef<HTMLSpanElement | null>(null);
  const pendingRestoreRef = useRef<RestoreDisclosureAnchor>(null);
  const contentId = `og-user-message-${useId().replace(/:/g, "")}`;

  const measure = useCallback(() => {
    const content = contentRef.current;
    const threshold = thresholdRef.current;
    if (!content || !threshold) {
      return;
    }
    const renderedHeight = Math.max(content.scrollHeight, content.getBoundingClientRect().height);
    const collapseHeight = Math.max(
      threshold.offsetHeight,
      threshold.getBoundingClientRect().height,
    );
    setCollapsible(
      renderedHeight > 0 && collapseHeight > 0
        ? renderedHeight > collapseHeight + 1
        : userMessageLikelyNeedsDisclosure(text),
    );
  }, [text]);

  useLayoutEffect(() => {
    measure();
    const content = contentRef.current;
    const threshold = thresholdRef.current;
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure());
    if (content) {
      observer?.observe(content);
    }
    if (threshold) {
      observer?.observe(threshold);
    }
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  useLayoutEffect(() => {
    const restore = pendingRestoreRef.current;
    pendingRestoreRef.current = null;
    restore?.();
  }, [expanded]);

  const toggle = (control: HTMLButtonElement) => {
    const root = rootRef.current;
    pendingRestoreRef.current = root && disclosure ? disclosure.beginChange(root, control) : null;
    const next = !expanded;
    disclosure?.expandedByMessageId.set(messageId, next);
    setExpanded(next);
  };

  const collapsed = collapsible && !expanded;

  return (
    <div
      ref={rootRef}
      data-og-user-message-body=""
      data-og-message-id={messageId}
      data-og-expanded={expanded ? "true" : "false"}
      className={cn("relative min-w-0", className)}
    >
      <span
        ref={thresholdRef}
        aria-hidden="true"
        className="pointer-events-none absolute h-56 w-0 invisible sm:h-72"
      />
      <div
        id={contentId}
        data-og-user-message-clip=""
        className={cn("relative min-w-0", collapsed && "max-h-56 overflow-hidden sm:max-h-72")}
      >
        <div
          ref={contentRef}
          data-og-user-message-content=""
          className="min-w-0 [overflow-wrap:anywhere]"
        >
          {children}
        </div>
        {collapsed ? (
          <span
            aria-hidden="true"
            data-og-user-message-fade=""
            className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-og-surface-2 via-og-surface-2/90 to-transparent"
          />
        ) : null}
      </div>
      {collapsible ? (
        <button
          type="button"
          aria-controls={contentId}
          aria-expanded={expanded}
          data-og-user-message-disclosure=""
          className="mt-1.5 inline-flex min-h-7 items-center rounded-og-sm px-1.5 text-og-xs font-medium text-og-fg-muted outline-none transition-colors hover:bg-og-surface-3/60 hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent/45 pointer-coarse:min-h-11"
          onClick={(event) => toggle(event.currentTarget)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}
