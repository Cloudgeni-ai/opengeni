/**
 * A quiet tag naming the workspace a chat lives in, shown in the ⌘K menu and
 * the chat switcher when that is not the workspace on screen.
 */
export function WorkspaceTag(props: { name: string }) {
  return (
    <span
      title={`In ${props.name}`}
      className="max-w-[40%] shrink-0 truncate rounded-[5px] bg-surface-3 px-1.5 py-px text-2xs leading-4 font-medium text-fg-muted"
    >
      <span className="sr-only">In workspace </span>
      {props.name}
    </span>
  );
}
