import { CheckIcon } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
  type RefObject,
} from "react";
import { DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@/components/ui/dropdown-menu";
import {
  MENU_BUTTON_CLASS,
  MENU_CHECK_CLASS,
  MENU_CHECK_SLOT_CLASS,
  MENU_META_CLASS,
} from "@/components/ui/menu-styles";
import { cn } from "@/lib/utils";

/** Dropdowns rove through menu items; dialogs use ordinary Tab stops. */
export type MenuBodyPresentation = "menu" | "dialog";

const RadioGroupContext = createContext<{
  presentation: MenuBodyPresentation;
  value: string | null;
}>({ presentation: "menu", value: null });

export function RadioGroup(props: {
  presentation: MenuBodyPresentation;
  label: string;
  value: string | null;
  className?: string;
  children: ReactNode;
}) {
  const { presentation, value } = props;
  const context = useMemo(() => ({ presentation, value }), [presentation, value]);
  return (
    <RadioGroupContext.Provider value={context}>
      {presentation === "menu" ? (
        <DropdownMenuRadioGroup
          value={value ?? ""}
          aria-label={props.label}
          className={props.className}
        >
          {props.children}
        </DropdownMenuRadioGroup>
      ) : (
        <div role="radiogroup" aria-label={props.label} className={props.className}>
          {props.children}
        </div>
      )}
    </RadioGroupContext.Provider>
  );
}

export function RadioRow(props: {
  value: string;
  disabled?: boolean;
  icon?: ReactNode;
  label: string;
  meta?: string;
  className?: string;
  ref?: (node: HTMLElement | null) => void;
  onSelect: () => void;
}) {
  const group = useContext(RadioGroupContext);
  const content = (
    <>
      {props.icon}
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.meta ? <span className={MENU_META_CLASS}>{props.meta}</span> : null}
    </>
  );
  if (group.presentation === "menu") {
    return (
      <DropdownMenuRadioItem
        ref={props.ref}
        value={props.value}
        disabled={props.disabled}
        onSelect={(event) => {
          // Choices can reveal more choices, or report a pending mutation.
          event.preventDefault();
          props.onSelect();
        }}
        className={cn("cursor-pointer", props.className)}
      >
        {content}
      </DropdownMenuRadioItem>
    );
  }
  const checked = group.value === props.value;
  return (
    <button
      ref={props.ref}
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={props.disabled}
      onClick={props.onSelect}
      className={cn(MENU_BUTTON_CLASS, props.className)}
    >
      {content}
      <span className={MENU_CHECK_SLOT_CLASS}>
        {checked ? <CheckIcon className={MENU_CHECK_CLASS} /> : null}
      </span>
    </button>
  );
}

/** A drill-in replaces its opener; start roving focus on the checked enabled row. */
export function useFocusCheckedRow(
  ref: RefObject<HTMLElement | null>,
  presentation: MenuBodyPresentation,
) {
  useEffect(() => {
    const body = ref.current;
    if (presentation !== "menu" || !body || body.contains(document.activeElement)) return;
    const enabled = '[role="menuitemradio"]:not([data-disabled])';
    const row =
      body.querySelector<HTMLElement>(`${enabled}[aria-checked="true"]`) ??
      body.querySelector<HTMLElement>(enabled);
    row?.focus({ preventScroll: true });
    // Only on open: later choices keep focus where the user put it.
  }, [ref, presentation]);
}
