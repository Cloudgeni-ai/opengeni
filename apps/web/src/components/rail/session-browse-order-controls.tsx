import type { SessionBrowseGroupBy, SessionBrowseSortBy } from "@/lib/sessions-group";
import type { SessionBrowseStatus } from "@/lib/session-browse-preferences";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuMeta,
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
  "needs-you": "Needs you",
  archived: "Archived",
  all: "All",
};

function ViewSubmenu<T extends string>({
  label,
  value,
  choices,
  counts,
  onChange,
}: {
  label: string;
  value: T;
  choices: Record<T, string>;
  /** A quiet number beside a choice, shown only when positive. */
  counts?: Partial<Record<T, number>>;
  onChange: (value: T) => void;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="[&>svg]:ml-0">
        {label}
        <DropdownMenuMeta>{choices[value]}</DropdownMenuMeta>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-44">
        <DropdownMenuRadioGroup
          aria-label={label}
          value={value}
          onValueChange={(next) => onChange(next as T)}
        >
          {(Object.keys(choices) as T[]).map((choice) => (
            <DropdownMenuRadioItem key={choice} value={choice}>
              {choices[choice]}
              {counts?.[choice] ? (
                <DropdownMenuMeta aria-label={`${counts[choice]} waiting`}>
                  {counts[choice]}
                </DropdownMenuMeta>
              ) : null}
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
  needsYouCount = 0,
  showEmptyGroups,
  onShowEmptyGroupsChange,
}: {
  groupBy: SessionBrowseGroupBy;
  onGroupByChange: (value: SessionBrowseGroupBy) => void;
  sortBy: SessionBrowseSortBy;
  onSortByChange: (value: SessionBrowseSortBy) => void;
  status: SessionBrowseStatus;
  onStatusChange: (value: SessionBrowseStatus) => void;
  /** Loaded workstreams waiting on the person, counted beside "Needs you". */
  needsYouCount?: number;
  showEmptyGroups: boolean;
  onShowEmptyGroupsChange: (value: boolean) => void;
}) {
  return (
    <>
      <ViewSubmenu
        label="Status"
        value={status}
        choices={STATUSES}
        counts={{ "needs-you": needsYouCount }}
        onChange={onStatusChange}
      />
      <DropdownMenuSeparator />
      <ViewSubmenu label="Group by" value={groupBy} choices={GROUPS} onChange={onGroupByChange} />
      <ViewSubmenu label="Sort by" value={sortBy} choices={SORTS} onChange={onSortByChange} />
      <DropdownMenuSeparator />
      <DropdownMenuCheckboxItem
        checked={showEmptyGroups}
        disabled={groupBy === "none"}
        onCheckedChange={(checked) => onShowEmptyGroupsChange(checked === true)}
      >
        Show empty groups
      </DropdownMenuCheckboxItem>
    </>
  );
}
