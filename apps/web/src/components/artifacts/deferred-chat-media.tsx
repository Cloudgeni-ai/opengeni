import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Reserve the chat slot before starting expensive media work. Activation is
 * one-way: scrolling away must not discard an interactive preview's state.
 * The timeline parks at its initial tip in layout effects before this observer
 * is attached, so historical previews above the entry viewport stay dormant.
 */
export function DeferredChatMedia({
  children,
  height,
  label,
}: {
  children: ReactNode;
  height: number;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  useEffect(() => {
    const node = host.current;
    if (active || !node) return;
    if (typeof IntersectionObserver === "undefined") {
      setActive(true);
      return;
    }
    let disposed = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (disposed || !entries.some((entry) => entry.isIntersecting)) return;
        setActive(true);
        observer.disconnect();
      },
      {
        root: node.closest("[data-og-timeline-scroller]"),
        rootMargin: "200px 0px",
      },
    );
    observer.observe(node);
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [active]);

  return (
    <div ref={host} data-chat-media={active ? "active" : "deferred"}>
      {active ? (
        children
      ) : (
        <div className="flex w-full items-center justify-center" style={{ height }}>
          <button
            type="button"
            className="rounded-md px-3 py-2 text-sm text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => setActive(true)}
          >
            Load {label}
          </button>
        </div>
      )}
    </div>
  );
}
