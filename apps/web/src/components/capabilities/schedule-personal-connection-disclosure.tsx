import { UserRoundIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function SchedulePersonalConnectionDisclosure({
  ownerSubjectId,
  viewerSubjectId,
  className,
}: {
  ownerSubjectId: string | null;
  viewerSubjectId: string;
  className?: string;
}) {
  if (!ownerSubjectId) return null;
  const own = ownerSubjectId === viewerSubjectId;
  return (
    <div
      className={cn("mt-1.5 flex min-w-0 items-center gap-1.5 text-2xs text-fg-subtle", className)}
      title="Each run uses the owner's connected accounts. Only the owner can edit or run this schedule."
    >
      <UserRoundIcon className="size-3 shrink-0" />
      <span>
        {own
          ? "Runs as you · uses your connected accounts"
          : "Runs as its owner · only the owner can edit or run"}
      </span>
    </div>
  );
}
