// A semantic stand-in for the Radix menu: the same triggers and items, rendered
// in place, so menu choices can be read and clicked in happy-dom. Pass it to
// mock.module("../src/ui/dropdown-menu", dropdownMenuStub). It exports every
// name the real module does, so a leaked mock never breaks another file.
import type { ReactNode } from "react";

type ItemProps = {
  children?: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  [key: string]: unknown;
};

function dataProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith("data-") || key.startsWith("aria-") || key === "title") out[key] = value;
  }
  return out;
}

export function dropdownMenuStub() {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const Block = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  let radioChange: ((value: string) => void) | undefined;
  const Item =
    (role: string) =>
    ({ children, onSelect, disabled, ...rest }: ItemProps) => (
      <button
        type="button"
        role={role}
        disabled={disabled}
        {...dataProps(rest)}
        onClick={() => onSelect?.()}
      >
        {children}
      </button>
    );
  return {
    DropdownMenu: Pass,
    DropdownMenuPortal: Pass,
    DropdownMenuGroup: Pass,
    DropdownMenuSub: Pass,
    DropdownMenuSubTrigger: Block,
    DropdownMenuSubContent: Block,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: ({ children }: { children?: ReactNode }) => (
      <div role="menu">{children}</div>
    ),
    DropdownMenuLabel: Block,
    DropdownMenuNote: Block,
    DropdownMenuMeta: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    DropdownMenuShortcut: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuCheck: ({ checked }: { checked: boolean }) => (checked ? <span>✓</span> : null),
    DropdownMenuItem: Item("menuitem"),
    DropdownMenuCheckboxItem: Item("menuitemcheckbox"),
    DropdownMenuRadioGroup: ({
      children,
      onValueChange,
    }: {
      children?: ReactNode;
      onValueChange?: (value: string) => void;
    }) => {
      radioChange = onValueChange;
      const change = onValueChange;
      return <div data-radio-group="">{wrapRadio(children, change)}</div>;
    },
    DropdownMenuRadioItem: ({
      children,
      value,
      disabled,
      ...rest
    }: ItemProps & { value: string }) => (
      <button
        type="button"
        role="menuitemradio"
        disabled={disabled}
        data-radio-value={value}
        {...dataProps(rest)}
        onClick={(event) => {
          const group = (event.currentTarget as HTMLElement).closest("[data-radio-group]");
          const change = (group as unknown as { __change?: (value: string) => void } | null)
            ?.__change;
          (change ?? radioChange)?.(value);
        }}
      >
        {children}
      </button>
    ),
  };
}

// Radio items find their group's handler through the DOM node.
function wrapRadio(children: ReactNode, change: ((value: string) => void) | undefined): ReactNode {
  return (
    <span
      style={{ display: "contents" }}
      ref={(node) => {
        const group = node?.parentElement as unknown as { __change?: unknown } | null;
        if (group) group.__change = change;
      }}
    >
      {children}
    </span>
  );
}
