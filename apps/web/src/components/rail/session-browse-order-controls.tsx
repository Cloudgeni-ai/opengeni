import type { SessionBrowseGroupBy } from "@/lib/sessions-group";
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";

/** Describe the existing order without offering unsupported server-side sorts. */
export function SessionBrowseOrderControls({
  groupBy,
  onGroupByChange,
}: {
  groupBy: SessionBrowseGroupBy;
  onGroupByChange: (value: SessionBrowseGroupBy) => void;
}) {
  return (
    <>
      <DropdownMenuLabel>Sort by</DropdownMenuLabel>
      <div className="px-2 pb-2" data-session-sort-summary>
        <p className="text-sm">
          {groupBy === "created" ? "Created date" : "Last activity"} · newest first
        </p>
        <p className="mt-1 text-2xs leading-4 text-fg-subtle">
          {groupBy === "created"
            ? "Within loaded date groups. More sessions load by activity, not creation date."
            : "Within groups. Sort order is fixed."}
        </p>
      </div>
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          Group by
          <span className="ml-auto mr-1 text-2xs text-fg-subtle">
            {groupBy === "activity"
              ? "Last activity"
              : groupBy === "created"
                ? "Created date"
                : "Creator"}
          </span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-44">
          <DropdownMenuRadioGroup
            aria-label="Group by"
            value={groupBy}
            onValueChange={(value) => onGroupByChange(value as SessionBrowseGroupBy)}
          >
            <DropdownMenuRadioItem value="activity">Last activity</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="created">Created date</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="creator">Creator</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}
