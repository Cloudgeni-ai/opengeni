import type { SessionAdminAccess } from "@opengeni/sdk";
import { ShieldCheckIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FormDialog } from "@/components/ui/form-dialog";
import { useAppContext } from "@/context";
import { hasInbox } from "@/lib/inbox";

/* ----------------------------------------------------------------------------
   Admin access for one session. An owner or admin gives one of their own
   sessions admin access (when the organization allows it, in Organization
   settings > Security & data); its agent can then manage what they can across
   the organization, as them. The header shows a small shield while it is on,
   with a one-click way to turn it off.
   -------------------------------------------------------------------------- */

export type SessionAdminAccessControl = {
  state: SessionAdminAccess;
  busy: boolean;
  grant: () => Promise<void>;
  revoke: () => void;
};

export function useSessionAdminAccess(session: {
  workspaceId: string;
  id: string;
}): SessionAdminAccessControl | null {
  const context = useAppContext();
  const client = context.client;
  const applies = hasInbox(context.accessContext);
  const [state, setState] = useState<SessionAdminAccess | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setState(null);
    if (!applies) return;
    let current = true;
    client
      .getSessionAdminAccess(session.workspaceId, session.id)
      .then((value) => {
        if (current) setState(value);
      })
      // Older servers, or no access to read it: nothing to show.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [applies, client, session.id, session.workspaceId]);

  const grant = useCallback(async () => {
    setBusy(true);
    try {
      const value = await client.grantSessionAdminAccess(session.workspaceId, session.id);
      setState(value);
      toast.success("This session has admin access", {
        description: "Its agent can use it from its next message.",
      });
    } finally {
      setBusy(false);
    }
  }, [client, session.id, session.workspaceId]);

  const revoke = useCallback(() => {
    if (busy) return;
    setBusy(true);
    client
      .revokeSessionAdminAccess(session.workspaceId, session.id)
      .then((value) => {
        setState(value);
        toast.success("Admin access is off for this session");
      })
      .catch((error: unknown) => {
        toast.error("Couldn't turn off admin access", {
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => setBusy(false));
  }, [busy, client, session.id, session.workspaceId]);

  if (!state) return null;
  if (!state.active && !state.canGrant) return null;
  return { state, busy, grant, revoke };
}

function grantedByText(state: SessionAdminAccess): string {
  const name = state.grantedBy?.name;
  return name
    ? `This agent can manage what ${name} can across the organization, and acts as them.`
    : "This agent can manage what the person who gave it access can across the organization, and acts as them.";
}

/** The small shield beside the title while the session has admin access. */
export function SessionAdminAccessIndicator({ control }: { control: SessionAdminAccessControl }) {
  if (!control.state.active) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Admin access is on"
          title="Admin access is on"
          data-session-admin-access=""
          className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 text-2xs text-fg-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-ring/55 pointer-coarse:min-h-11"
        >
          <ShieldCheckIcon aria-hidden="true" className="size-3 shrink-0 text-warning" />
          <span className="hidden sm:inline">Admin</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <div className="px-2 py-1.5 text-xs text-fg-muted">
          <p className="font-medium text-fg">Admin access is on</p>
          <p className="mt-1">{grantedByText(control.state)}</p>
        </div>
        {control.state.canRevoke ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={control.busy} onSelect={() => control.revoke()}>
              Turn off admin access
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Confirms giving this session admin access. */
export function GrantSessionAdminAccessDialog({
  control,
  open,
  onOpenChange,
}: {
  control: SessionAdminAccessControl;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title="Give this session admin access?"
      description="Its agent can then manage what you can across the organization: sessions in every workspace, settings, connections and people. Everything it does runs as you. You can turn it off at any time from the shield beside the title."
      submitLabel="Give admin access"
      pendingLabel="Giving access…"
      initialFocus="cancel"
      onSubmit={async () => {
        await control.grant();
      }}
      onSubmitted={() => onOpenChange(false)}
    />
  );
}
