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
const INTERACTIVE_DESCENDANT_SELECTOR = [
  "a[href]",
  "area[href]",
  "button",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "iframe",
  "object",
  "embed",
  "audio[controls]",
  "video[controls]",
  "summary",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='textbox']",
  "[role='combobox']",
  "[role='listbox']",
  "[role='menuitem']",
  "[role='option']",
  "[role='tab']",
  "[role='treeitem']",
].join(",");

function composedParentElement(element: Element): Element | null {
  if (element.assignedSlot) {
    return element.assignedSlot;
  }
  if (element.parentElement) {
    return element.parentElement;
  }
  const root = element.getRootNode();
  return typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot ? root.host : null;
}

function hasComposedInertAncestor(element: Element, boundary: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (current.hasAttribute("inert")) {
      return true;
    }
    if (current === boundary) {
      return false;
    }
    current = composedParentElement(current);
  }
  return false;
}

/**
 * Native inert crosses shadow boundaries, but ordinary selectors do not.
 * Recursively inspect open roots control-by-control so visible shadow content
 * stays interactive. An opaque custom-element host is the conservative focus
 * boundary for a closed root that cannot be inspected.
 */
function collectInteractionBoundaries(root: ParentNode): HTMLElement[] {
  const boundaries: HTMLElement[] = [];
  const scopes: ParentNode[] = [root];
  for (let scopeIndex = 0; scopeIndex < scopes.length; scopeIndex += 1) {
    for (const element of scopes[scopeIndex]!.querySelectorAll("*")) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }
      const shadowRoot = element.shadowRoot;
      const opaqueCustomElement = element.localName.includes("-") && !shadowRoot;
      if (element.matches(INTERACTIVE_DESCENDANT_SELECTOR) || opaqueCustomElement) {
        boundaries.push(element);
      }
      if (shadowRoot) {
        scopes.push(shadowRoot);
      }
    }
  }
  return boundaries;
}

function isFullyInsideVisiblePreview(rect: DOMRect, clipRect: DOMRect): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.top >= clipRect.top - 1 &&
    rect.bottom <= clipRect.bottom + 1 &&
    rect.left >= clipRect.left - 1 &&
    rect.right <= clipRect.right + 1
  );
}

type RestoreDisclosureAnchor = (() => void) | null;

type SharedResizeObserverState = {
  callbacks: Map<Element, () => void>;
  observer: ResizeObserver;
};

type DisclosureMeasurementJob = {
  read: () => boolean;
  write: (collapsible: boolean) => void;
};

const sharedResizeObservers = new WeakMap<Window, SharedResizeObserverState>();
const disclosureMeasurementJobs = new Map<object, DisclosureMeasurementJob>();
let disclosureMeasurementQueued = false;

/**
 * Coalesce a commit's disclosure reads before applying any presentation writes.
 * Reading and writing one message at a time forced a fresh layout for every
 * newly mounted row in large history prepends.
 */
function scheduleDisclosureMeasurement(
  view: Window,
  key: object,
  job: DisclosureMeasurementJob,
): () => void {
  disclosureMeasurementJobs.set(key, job);
  if (!disclosureMeasurementQueued) {
    disclosureMeasurementQueued = true;
    view.queueMicrotask(() => {
      disclosureMeasurementQueued = false;
      const pending = [...disclosureMeasurementJobs.values()];
      disclosureMeasurementJobs.clear();
      const decisions = pending.map(({ read }) => read());
      for (let index = 0; index < pending.length; index += 1) {
        pending[index]!.write(decisions[index]!);
      }
    });
  }
  return () => disclosureMeasurementJobs.delete(key);
}

function observeSharedResize(element: Element, callback: () => void): (() => void) | null {
  const view = element.ownerDocument.defaultView;
  if (!view || typeof ResizeObserver === "undefined") {
    return null;
  }
  let state = sharedResizeObservers.get(view);
  if (!state) {
    const callbacks = new Map<Element, () => void>();
    const observer = new ResizeObserver((entries) => {
      if (entries.length === 0) {
        for (const registered of new Set(callbacks.values())) registered();
      } else {
        for (const entry of entries) {
          callbacks.get(entry.target)?.();
        }
      }
    });
    state = { callbacks, observer };
    sharedResizeObservers.set(view, state);
  }
  state.callbacks.set(element, callback);
  state.observer.observe(element);
  return () => {
    if (state.callbacks.get(element) !== callback) {
      return;
    }
    state.callbacks.delete(element);
    state.observer.unobserve(element);
    if (state.callbacks.size === 0) {
      state.observer.disconnect();
      sharedResizeObservers.delete(view);
    }
  };
}

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
  const collapsibleRef = useRef(userMessageLikelyNeedsDisclosure(text));
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const clipRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const thresholdRef = useRef<HTMLSpanElement | null>(null);
  const fadeRef = useRef<HTMLSpanElement | null>(null);
  const disclosureControlRef = useRef<HTMLButtonElement | null>(null);
  const pendingRestoreRef = useRef<RestoreDisclosureAnchor>(null);
  const managedInertDescendantsRef = useRef(new Set<HTMLElement>());
  const measurementKeyRef = useRef({});
  const contentId = `og-user-message-${useId().replace(/:/g, "")}`;
  const collapsible = collapsibleRef.current;
  const collapsed = collapsible && !expanded;

  const syncDisclosurePresentation = useCallback((nextCollapsible: boolean) => {
    collapsibleRef.current = nextCollapsible;
    const nextCollapsed = nextCollapsible && !expandedRef.current;
    const clip = clipRef.current;
    clip?.classList.toggle("max-h-56", nextCollapsed);
    clip?.classList.toggle("overflow-hidden", nextCollapsed);
    clip?.classList.toggle("sm:max-h-72", nextCollapsed);
    if (fadeRef.current) fadeRef.current.hidden = !nextCollapsed;
    if (disclosureControlRef.current) disclosureControlRef.current.hidden = !nextCollapsible;
  }, []);

  const restoreManagedInertDescendants = useCallback(() => {
    for (const descendant of managedInertDescendantsRef.current) {
      if (descendant.hasAttribute("data-og-user-message-managed-inert")) {
        descendant.removeAttribute("inert");
        descendant.removeAttribute("data-og-user-message-managed-inert");
      }
    }
    managedInertDescendantsRef.current.clear();
  }, []);

  const syncCollapsedInteractivity = useCallback(() => {
    restoreManagedInertDescendants();
    if (!collapsibleRef.current || expandedRef.current) {
      return;
    }

    const clip = clipRef.current;
    const content = contentRef.current;
    if (!clip || !content) {
      return;
    }

    const clipRect = clip.getBoundingClientRect();
    if (clipRect.height <= 0) {
      return;
    }

    for (const descendant of collectInteractionBoundaries(content)) {
      if (hasComposedInertAncestor(descendant, content)) {
        continue;
      }
      const rect = descendant.getBoundingClientRect();
      if (isFullyInsideVisiblePreview(rect, clipRect)) {
        continue;
      }
      descendant.setAttribute("inert", "");
      descendant.setAttribute("data-og-user-message-managed-inert", "");
      managedInertDescendantsRef.current.add(descendant);
    }
  }, [restoreManagedInertDescendants]);

  const readCollapsible = useCallback(() => {
    const content = contentRef.current;
    const threshold = thresholdRef.current;
    if (!content || !threshold) {
      return userMessageLikelyNeedsDisclosure(text);
    }
    const renderedHeight = Math.max(content.scrollHeight, content.getBoundingClientRect().height);
    const collapseHeight = Math.max(
      threshold.offsetHeight,
      threshold.getBoundingClientRect().height,
    );
    return renderedHeight > 0 && collapseHeight > 0
      ? renderedHeight > collapseHeight + 1
      : userMessageLikelyNeedsDisclosure(text);
  }, [text]);

  const measure = useCallback(() => {
    const view = rootRef.current?.ownerDocument.defaultView;
    if (!view) {
      syncDisclosurePresentation(readCollapsible());
      syncCollapsedInteractivity();
      return () => undefined;
    }
    return scheduleDisclosureMeasurement(view, measurementKeyRef.current, {
      read: readCollapsible,
      write: (nextCollapsible) => {
        syncDisclosurePresentation(nextCollapsible);
        syncCollapsedInteractivity();
      },
    });
  }, [readCollapsible, syncCollapsedInteractivity, syncDisclosurePresentation]);

  useLayoutEffect(() => {
    const cancelPendingMeasurement = measure();
    const content = contentRef.current;
    const threshold = thresholdRef.current;
    const onResize = () => {
      measure();
    };
    const stopObservingContent = content ? observeSharedResize(content, onResize) : null;
    const stopObservingThreshold = threshold ? observeSharedResize(threshold, onResize) : null;
    const observerAvailable = stopObservingContent !== null || stopObservingThreshold !== null;
    const handleResize = () => {
      measure();
    };
    // ResizeObserver already reports viewport-driven wrapping/height changes
    // for both measured elements. The window listener is only the fallback for
    // runtimes without ResizeObserver; installing both created one redundant
    // global listener per durable user message in large timelines.
    if (!observerAvailable) {
      window.addEventListener("resize", handleResize);
    }
    return () => {
      cancelPendingMeasurement();
      stopObservingContent?.();
      stopObservingThreshold?.();
      if (!observerAvailable) {
        window.removeEventListener("resize", handleResize);
      }
    };
  }, [measure, syncCollapsedInteractivity]);

  useLayoutEffect(() => {
    syncDisclosurePresentation(collapsibleRef.current);
    syncCollapsedInteractivity();
    return restoreManagedInertDescendants;
  }, [
    expanded,
    restoreManagedInertDescendants,
    syncCollapsedInteractivity,
    syncDisclosurePresentation,
  ]);

  useLayoutEffect(() => {
    const restore = pendingRestoreRef.current;
    pendingRestoreRef.current = null;
    restore?.();
  }, [expanded]);

  const toggle = (control: HTMLButtonElement) => {
    const root = rootRef.current;
    pendingRestoreRef.current = root && disclosure ? disclosure.beginChange(root, control) : null;
    const next = !expanded;
    if (!next && contentRef.current?.contains(document.activeElement)) {
      control.focus({ preventScroll: true });
    }
    disclosure?.expandedByMessageId.set(messageId, next);
    setExpanded(next);
  };

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
        ref={clipRef}
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
        <span
          ref={fadeRef}
          aria-hidden="true"
          hidden={!collapsed}
          data-og-user-message-fade=""
          className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-og-surface-2 via-og-surface-2/90 to-transparent"
        />
      </div>
      <button
        ref={disclosureControlRef}
        type="button"
        hidden={!collapsible}
        aria-controls={contentId}
        aria-expanded={expanded}
        data-og-user-message-disclosure=""
        className="mt-1.5 inline-flex min-h-7 items-center rounded-og-sm px-1.5 text-og-xs font-medium text-og-fg-muted outline-hidden transition-colors hover:bg-og-surface-3/60 hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent/45 pointer-coarse:min-h-11"
        onClick={(event) => toggle(event.currentTarget)}
      >
        {expanded ? "Show less" : "Show more"}
      </button>
    </div>
  );
}
