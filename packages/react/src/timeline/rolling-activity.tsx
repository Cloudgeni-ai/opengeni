import { renderActivity } from "./activity-rail";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { WrenchIcon } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { CompactActivityContext } from "./shared";
import { defaultToolRegistry } from "./tool-renderers";
import type { ToolRegistry } from "./registry";
import { toolDisplayName } from "./tool-display-name";
import type { ActivityItem } from "./types";

/** One stable viewport; updates replace its content without moving the conversation. */
export function RollingActivity({
  items,
  toolRegistry = defaultToolRegistry,
  previousItem,
}: {
  items: ActivityItem[];
  /** The standalone item visible immediately before this reel mounted. */
  previousItem?: ActivityItem | undefined;
  toolRegistry?: ToolRegistry;
}) {
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const work = items.filter((item) => item.kind !== "startup-phase");
  const active = work.filter((item) =>
    item.kind === "reasoning" ? item.streaming : "status" in item && item.status === "running",
  );
  // Advance with the event order; finishing a parallel tool must not replay an older one.
  const item = !mounted && previousItem ? previousItem : work.at(-1);
  if (!item) return null;
  const earlierCount = Math.max(
    0,
    work.findIndex((entry) => entry.id === item.id),
  );
  const fallback = (
    <span className="og-rolling-label">
      <WrenchIcon className="size-3.5" />
      <span>{item.kind === "tool-call" ? toolDisplayName(item.name) : "Working"}</span>
    </span>
  );
  return (
    <span
      className="og-rolling-status"
      data-running={active.some((entry) => entry.id === item.id) ? "true" : undefined}
    >
      <span className="sr-only">
        {item.kind === "tool-call"
          ? toolDisplayName(item.name)
          : item.kind === "reasoning"
            ? "Thinking"
            : "Working"}
      </span>
      <span className="og-rolling-window" aria-hidden="true">
        <AnimatePresence initial={false} mode="sync">
          <motion.span
            key={item.id}
            className="og-rolling-face"
            initial={{
              opacity: 0,
              y: reduced ? 0 : 24,
            }}
            animate={{ opacity: 1, y: 0 }}
            exit={{
              opacity: 0,
              y: reduced ? 0 : -24,
            }}
            transition={{ duration: reduced ? 0 : 0.4, ease: [0.22, 1, 0.36, 1] }}
          >
            <CompactActivityContext.Provider value={true}>
              <Suspense fallback={fallback}>
                {renderActivity(item, toolRegistry, undefined, undefined, undefined, undefined)}
              </Suspense>
            </CompactActivityContext.Provider>
          </motion.span>
        </AnimatePresence>
      </span>
      {earlierCount > 0 ? (
        <span className="og-rolling-count">{`+${earlierCount} earlier`}</span>
      ) : null}
    </span>
  );
}
