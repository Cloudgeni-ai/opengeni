import type { SessionBrowseGroupBy, SessionBrowseSortBy } from "@/lib/sessions-group";
import type { SessionBrowseStatus } from "@/lib/session-browse-preferences";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";

const GROUPS: Record<SessionBrowseGroupBy, string> = {
  activity: "Last activity",
  project: "Project",
  none: "None",
  created: "Created date",
  creator: "Creator",
};
const SORTS: Record<SessionBrowseSortBy, string> = {
  updatedAt: "Last activity",
  createdAt: "Created date",
  name: "Name",
};
const STATUSES: Record<SessionBrowseStatus, string> = {
  active: "Active",
  archived: "Archived",
  all: "All",
};

function ViewSubmenu<T extends string>({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: T;
  choices: Record<T, string>;
  onChange: (value: T) => void;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="pointer-coarse:min-h-11 [&>svg]:ml-0">
        {label}
        <span className="ml-auto mr-1 text-xs text-fg-subtle">{choices[value]}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-44">
        <DropdownMenuRadioGroup
          aria-label={label}
          value={value}
          onValueChange={(next) => onChange(next as T)}
        >
          {(Object.keys(choices) as T[]).map((choice) => (
            <DropdownMenuRadioItem key={choice} value={choice} className="pointer-coarse:min-h-11">
              {choices[choice]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function SessionBrowseOrderControls({
  groupBy,
  onGroupByChange,
  sortBy,
  onSortByChange,
  status,
  onStatusChange,
  showEmptyGroups,
  onShowEmptyGroupsChange,
}: {
  groupBy: SessionBrowseGroupBy;
  onGroupByChange: (value: SessionBrowseGroupBy) => void;
  sortBy: SessionBrowseSortBy;
  onSortByChange: (value: SessionBrowseSortBy) => void;
  status: SessionBrowseStatus;
  onStatusChange: (value: SessionBrowseStatus) => void;
  showEmptyGroups: boolean;
  onShowEmptyGroupsChange: (value: boolean) => void;
}) {
  return (
    <>
      <ViewSubmenu label="Status" value={status} choices={STATUSES} onChange={onStatusChange} />
      <DropdownMenuSeparator />
      <ViewSubmenu label="Group by" value={groupBy} choices={GROUPS} onChange={onGroupByChange} />
      <ViewSubmenu label="Sort by" value={sortBy} choices={SORTS} onChange={onSortByChange} />
      <DropdownMenuSeparator />
      <DropdownMenuCheckboxItem
        checked={showEmptyGroups}
        disabled={groupBy === "none"}
        className="pointer-coarse:min-h-11"
        onCheckedChange={(checked) => onShowEmptyGroupsChange(checked === true)}
      >
        Show empty groups
      </DropdownMenuCheckboxItem>
    </>
  );
}
