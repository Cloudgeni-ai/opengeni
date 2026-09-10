import { type CreatorRef, creatorHue, creatorInitials, creatorLabel } from "@/lib/creator-initials";
import { cn } from "@/lib/utils";

/**
 * The round creator chip: who started this workstream, at a glance. Renders
 * nothing for service/system creators and unattributed legacy rows, so the one
 * "the rail shows people, not machinery" rule lives in `creatorInitials`.
 *
 * Decorative by construction: `aria-hidden` with a `title` tooltip. The
 * surrounding row owns the screen-reader wording, so a chip and its
 * announcement never drift apart.
 */
export function CreatorMonogram({
  createdBy,
  className,
  showTitle = true,
}: {
  createdBy: CreatorRef;
  className?: string;
  /** Disable the native delayed tooltip when a richer parent hover surface owns the label. */
  showTitle?: boolean;
}) {
  const initials = creatorInitials(createdBy);
  if (!initials) return null;
  return (
    <span
      data-creator-monogram
      aria-hidden="true"
      title={showTitle ? creatorLabel(createdBy) : undefined}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full text-[8px] font-semibold leading-none text-white/90",
        className,
      )}
      style={{ background: `oklch(0.45 0.11 ${creatorHue(createdBy.subjectId)})` }}
    >
      {initials}
    </span>
  );
}
