import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   ReasonTooltip and DisabledReason (design brief 7, "Also build").

   One tooltip for "why": why a control is disabled, why a capability is
   unavailable, where a number comes from. It replaces native `title`
   attributes, which never show on touch or keyboard focus.

   - Keyboard: opens on focus, closes on Escape or blur (Radix).
   - Touch: a tap toggles it and a tap outside closes it. Radix tooltips
     ignore touch by default, so the open state is controlled here.
   - Screen readers: DisabledReason also links the reason to the control with
     `aria-describedby`, so it is announced without opening the tooltip.
   -------------------------------------------------------------------------- */

type TriggerProps = {
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  className?: string;
  disabled?: boolean;
  "aria-describedby"?: string;
};

export interface ReasonTooltipProps {
  /** The explanation. One or two short sentences: why, and who can fix it. */
  reason: ReactNode;
  /** One focusable element: a button, a link, or a badge with tabIndex 0. */
  children: ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  /** Hover delay in ms. Focus and touch open immediately. */
  delayDuration?: number;
  /**
   * Keep it open when the trigger is clicked (default), so a click explains
   * rather than dismisses. Set false when the trigger also does something.
   */
  openOnClick?: boolean;
}

/** A touch-safe, keyboard-reachable tooltip that explains something. */
export function ReasonTooltip({
  reason,
  children,
  side = "top",
  align = "center",
  delayDuration = 200,
  openOnClick = true,
}: ReasonTooltipProps) {
  const [open, setOpen] = useState(false);
  const lastPointer = useRef<{ type: string; wasOpen: boolean }>({ type: "", wasOpen: false });
  const pointerDown = useRef(false);
  const focusFrame = useRef(0);

  useEffect(() => () => cancelAnimationFrame(focusFrame.current), []);

  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={300}>
      <TooltipPrimitive.Root open={open} onOpenChange={setOpen}>
        <TooltipPrimitive.Trigger
          asChild
          onPointerDown={(event) => {
            lastPointer.current = { type: event.pointerType, wasOpen: open };
            pointerDown.current = true;
            document.addEventListener(
              "pointerup",
              () => {
                pointerDown.current = false;
              },
              { once: true },
            );
            // Radix closes on pointer down; a click on a disabled control should explain.
            if (openOnClick && event.pointerType !== "touch") event.preventDefault();
          }}
          onFocus={(event) => {
            // Radix opens on focus, but keyboard focus scrolls the trigger into
            // view and Radix closes tooltips when an ancestor scrolls, so the
            // tooltip flashed shut. Open after that scroll has settled instead.
            event.preventDefault();
            if (pointerDown.current) return;
            const trigger = event.currentTarget;
            cancelAnimationFrame(focusFrame.current);
            focusFrame.current = requestAnimationFrame(() => {
              focusFrame.current = requestAnimationFrame(() => {
                if (document.activeElement === trigger) setOpen(true);
              });
            });
          }}
          onBlur={() => cancelAnimationFrame(focusFrame.current)}
          onClick={(event) => {
            if (lastPointer.current.type === "touch") {
              // Radix ignores touch; make a tap toggle instead.
              event.preventDefault();
              setOpen(!lastPointer.current.wasOpen);
              return;
            }
            if (openOnClick) {
              event.preventDefault();
              setOpen(true);
            }
          }}
        >
          {children}
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            data-slot="reason-tooltip"
            side={side}
            align={align}
            sideOffset={6}
            collisionPadding={8}
            className={cn(
              "z-50 max-w-72 rounded-md bg-fg px-2.5 py-1.5 text-xs leading-4.5 text-bg shadow-md",
              "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-[120ms]",
            )}
          >
            {reason}
            <TooltipPrimitive.Arrow width={10} height={5} className="fill-fg" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

export interface DisabledReasonProps {
  /** Why the control can't be used, and who can change that. */
  reason: ReactNode;
  /** When false, the control renders untouched and no tooltip is attached. */
  disabled?: boolean;
  /** Exactly one control element (Button, Switch, icon button, link). */
  children: ReactElement<TriggerProps>;
  side?: ReasonTooltipProps["side"];
  align?: ReasonTooltipProps["align"];
}

const ACTIVATION_KEYS = new Set(["Enter", " "]);

/**
 * Wraps a disabled control so the reason is reachable by hover, focus and
 * tap. The control stays focusable (`aria-disabled` instead of `disabled`)
 * and every activation is blocked.
 */
export function DisabledReason({
  reason,
  disabled = true,
  children,
  side,
  align,
}: DisabledReasonProps) {
  const reasonId = useId();
  if (!disabled || !isValidElement(children)) return children;

  const describedBy = [children.props["aria-describedby"], reasonId].filter(Boolean).join(" ");
  const control = cloneElement(children, {
    disabled: false,
    "aria-disabled": true,
    "aria-describedby": describedBy,
    "data-disabled-reason": "",
    className: cn(children.props.className, "cursor-not-allowed opacity-50"),
    onClick: (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (ACTIVATION_KEYS.has(event.key)) event.preventDefault();
    },
  } as Partial<TriggerProps> & Record<string, unknown>);

  return (
    <>
      <ReasonTooltip reason={reason} side={side} align={align}>
        {control}
      </ReasonTooltip>
      <span id={reasonId} className="sr-only">
        {reason}
      </span>
    </>
  );
}
