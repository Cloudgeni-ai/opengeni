// "Move to group" for a sidebar item's menu, in the rail and on the Sidebar page.
import {
  DropdownMenuCheck,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@opengeni/react/ui/dropdown-menu";

export type SidebarGroupChoice = { id: string; label: string };

/** The groups an item can go to, and back to the top level when it's in one. */
export function MoveToGroupMenu({
  groups,
  current,
  onSelect,
}: {
  groups: readonly SidebarGroupChoice[];
  /** The item's group now, or null at the top level. */
  current: string | null;
  onSelect: (groupId: string | null) => void;
}) {
  if (!groups.some((group) => group.id !== current) && current === null) return null;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>Move to group</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-40">
        {groups.map((group) => (
          <DropdownMenuItem
            key={group.id}
            aria-current={group.id === current ? "true" : undefined}
            disabled={group.id === current}
            onSelect={() => onSelect(group.id)}
          >
            <span className="flex-1 truncate">{group.label}</span>
            <DropdownMenuCheck checked={group.id === current} />
          </DropdownMenuItem>
        ))}
        {current !== null ? (
          <DropdownMenuItem onSelect={() => onSelect(null)}>No group</DropdownMenuItem>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
