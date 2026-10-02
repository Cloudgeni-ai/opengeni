import { CheckIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A step's state as a 20px mark: a filled check when done (the person caused
 * it, so it may be green), an empty ring to do, a dashed ring when optional,
 * a faint ring while unknown. The words next to it carry the meaning; the
 * screen reader gets them here too.
 */
export function GetStartedStatusIcon({
  done,
  optional = false,
  className,
}: {
  done: boolean | null;
  optional?: boolean;
  className?: string;
}) {
  if (done === true)
    return (
      <span
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded-full bg-status-idle text-canvas",
          className,
        )}
      >
        <CheckIcon aria-hidden="true" className="size-3" strokeWidth={3} />
        <span className="sr-only">Done:</span>
      </span>
    );
  return (
    <span
      className={cn(
        "size-5 shrink-0 rounded-full border-[1.5px]",
        done === null
          ? "border-border"
          : optional
            ? "border-dashed border-border-strong"
            : "border-border-strong",
        className,
      )}
    >
      <span className="sr-only">{done === null ? "Checking:" : "To do:"}</span>
    </span>
  );
}
