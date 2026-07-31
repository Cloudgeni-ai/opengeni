/**
 * Token-styled Radix tooltip — SDK counterpart to apps/web `components/ui/tooltip`.
 * Portals copy `--og-*` tokens so embeds keep the host theme outside `.og-root`.
 *
 * Background/foreground are applied as inline styles (not only Tailwind
 * utilities): `.og-root` sets `color: var(--og-color-fg)` after utilities in the
 * consumer CSS cascade, which would otherwise paint light-on-light inverted
 * tips and look like a blank white bubble.
 */
import { Tooltip as TooltipPrimitive } from "radix-ui";
import {
  createContext,
  useContext,
  useRef,
  type ComponentProps,
  type CSSProperties,
  type RefObject,
} from "react";

import { cn } from "../lib/cn";
import { usePortalTokenStyle } from "../lib/use-portal-token-style";

const TooltipSourceContext = createContext<RefObject<HTMLElement | null> | null>(null);

function TooltipProvider({
  delayDuration = 300,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />;
}

function Tooltip({ children, ...props }: ComponentProps<typeof TooltipPrimitive.Root>) {
  const sourceRef = useRef<HTMLElement | null>(null);
  return (
    <TooltipSourceContext.Provider value={sourceRef}>
      <TooltipPrimitive.Root data-slot="tooltip" {...props}>
        {children}
      </TooltipPrimitive.Root>
    </TooltipSourceContext.Provider>
  );
}

function TooltipTrigger({
  asChild = true,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Trigger>) {
  const sourceRef = useContext(TooltipSourceContext);
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      asChild={asChild}
      ref={(node) => {
        if (sourceRef) sourceRef.current = node;
      }}
      {...props}
    />
  );
}

const tooltipSurfaceStyle: CSSProperties = {
  backgroundColor: "var(--og-color-fg)",
  color: "var(--og-color-bg)",
};

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  style,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>) {
  const sourceRef = useContext(TooltipSourceContext);
  const fallbackRef = useRef<HTMLElement | null>(null);
  const portalStyle = usePortalTokenStyle(sourceRef ?? fallbackRef);

  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "og-root z-50 w-fit max-w-xs origin-[var(--radix-tooltip-content-transform-origin)]",
          "rounded-og-md px-2.5 py-1.5 text-og-xs leading-4 text-balance shadow-og-md",
          "animate-og-enter data-[state=closed]:opacity-0 data-[state=closed]:transition-opacity",
          className,
        )}
        style={{ ...portalStyle, ...tooltipSurfaceStyle, ...style }}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow
          className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px]"
          style={{
            backgroundColor: "var(--og-color-fg)",
            fill: "var(--og-color-fg)",
          }}
        />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
