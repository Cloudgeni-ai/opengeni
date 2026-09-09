import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { ChevronsUpDownIcon } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

export const SETTINGS_SWITCHER_CLASS =
  "w-full border-brand/25 bg-brand-strong/10 py-2 hover:border-brand/40 hover:bg-brand-strong/15";

export const ScopeSwitcherTrigger = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
    label: string;
    icon: ReactNode;
    badge?: ReactNode;
  }
>(function ScopeSwitcherTrigger({ label, icon, badge, className, ...props }, ref) {
  return (
    <button
      {...props}
      ref={ref}
      type="button"
      className={cn(
        "group flex min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-md border border-border bg-surface-2/50 px-2 py-1.5 text-left transition-colors hover:border-border-strong hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
        className,
      )}
    >
      <Avatar size="sm" className="rounded-md">
        <AvatarFallback className="rounded-md bg-brand-strong/25 text-2xs font-semibold text-brand">
          {icon}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1 truncate text-sm font-medium" title={label}>
        {label}
      </span>
      {badge}
      <ChevronsUpDownIcon aria-hidden="true" className="size-3.5 shrink-0 text-fg-subtle" />
    </button>
  );
});
