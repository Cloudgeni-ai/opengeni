import { Link } from "@tanstack/react-router";
import { SparkleIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface TopBarProps {
  children?: ReactNode;
  className?: string;
}

export function TopBar({ children, className }: TopBarProps) {
  return (
    <header
      className={cn(
        "sticky top-0 z-40 flex h-14 items-center gap-3 border-b",
        "border-[color:var(--color-border)] bg-[color:var(--color-bg)]/75 backdrop-blur",
        "px-4 sm:px-6",
        className,
      )}
    >
      <Link
        to="/"
        aria-label="Infra Agent Console home"
        className={cn(
          "flex items-center gap-2 rounded-md px-1.5 py-1 text-[15px] font-medium",
          "text-[color:var(--color-fg)] hover:bg-[color:var(--color-surface-2)]",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "flex size-6 items-center justify-center rounded-md",
            "bg-[color:var(--color-brand-strong)]/20 text-[color:var(--color-brand)]",
          )}
        >
          <SparkleIcon className="size-3.5" />
        </span>
        <span>Infra Agent</span>
      </Link>
      <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2">
        {children}
      </div>
    </header>
  );
}
