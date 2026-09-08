import { Loader2Icon, PlusIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

export function SubscriptionConnectAction(props: {
  provider: string;
  count: number;
  busy: boolean;
  onConnect: () => void;
  scopeControl?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="flex-1 text-xs text-fg-subtle">
        {props.count === 0
          ? `No ${props.provider} subscriptions connected.`
          : `${props.count} subscription${props.count === 1 ? "" : "s"} connected.`}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {props.scopeControl}
        <Button type="button" size="sm" disabled={props.busy} onClick={props.onConnect}>
          {props.busy ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <PlusIcon className="size-3.5" />
          )}
          {props.count === 0 ? "Connect account" : "Connect another account"}
        </Button>
      </div>
    </div>
  );
}
