// The small card the browser shows while it finishes, or once it has finished,
// a sign-in started in the desktop app.
import { AlertCircleIcon, CheckCircle2Icon, Loader2Icon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@opengeni/react/app/lib/utils";

export type ConnectReturnTone = "working" | "connected" | "failed" | "done";

const ICONS = {
  working: Loader2Icon,
  connected: CheckCircle2Icon,
  failed: AlertCircleIcon,
  done: CheckCircle2Icon,
} as const;

export function ConnectReturnCard({
  tone,
  title,
  body,
  children,
}: {
  tone: ConnectReturnTone;
  title: string;
  body?: string | undefined;
  children?: ReactNode;
}) {
  const Icon = ICONS[tone];
  return (
    <section className="og-page-glow flex flex-1 items-center justify-center px-4">
      <div
        className="w-full max-w-sm rounded-xl border border-border bg-surface p-6"
        role={tone === "failed" ? "alert" : "status"}
      >
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-md",
              tone === "failed" ? "bg-danger/15 text-danger" : "bg-brand-strong/20 text-brand",
            )}
          >
            <Icon className={cn("size-4", tone === "working" && "animate-spin")} />
          </span>
          <div className="min-w-0 pt-1">
            <h1 className="text-base font-semibold">{title}</h1>
            {body ? <p className="mt-1 text-sm text-fg-muted">{body}</p> : null}
          </div>
        </div>
        {children}
      </div>
    </section>
  );
}
