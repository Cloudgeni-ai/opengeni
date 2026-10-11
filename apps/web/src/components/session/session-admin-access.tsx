import type { SessionAdminAccess } from "@opengeni/sdk";
import { ShieldCheckIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldStack } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useAppContext } from "@/context";
import { hasInbox } from "@/lib/inbox";

/* ----------------------------------------------------------------------------
   Admin access for one session. An owner or admin gives one of their own
   sessions admin access (when the organization allows it, in Organization
   settings > Security & data) for an hour, a few hours, a day or with no
   time limit; its agent can then manage what they can across the
   organization, as them. The header shows a small shield while it is on,
   with when it ends and a one-click way to turn it off.
   -------------------------------------------------------------------------- */

/** How long admin access lasts, as offered in the app. */
export type AdminAccessDuration = "1" | "8" | "24" | "none";

export const ADMIN_ACCESS_DURATIONS: ReadonlyArray<{
  value: AdminAccessDuration;
  label: string;
}> = [
  { value: "1", label: "1 hour" },
  { value: "8", label: "8 hours" },
  { value: "24", label: "1 day" },
  { value: "none", label: "No limit" },
];

function durationHours(duration: AdminAccessDuration): number | null {
  return duration === "none" ? null : Number(duration);
}

export type SessionAdminAccessControl = {
  state: SessionAdminAccess;
  busy: boolean;
  grant: (duration: AdminAccessDuration) => Promise<void>;
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
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
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
  }, [applies, client, reloads, session.id, session.workspaceId]);
  useEffect(() => {
    setState(null);
  }, [session.id, session.workspaceId]);

  // When the time limit is reached, read it again so the shield goes away.
  const expiresAt = state?.active ? state.expiresAt : null;
  useEffect(() => {
    if (!expiresAt) return;
    const delay = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(delay)) return;
    const timer = setTimeout(
      () => setReloads((count) => count + 1),
      Math.min(Math.max(delay + 1_000, 0), 2_147_000_000),
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);

  const grant = useCallback(
    async (duration: AdminAccessDuration) => {
      setBusy(true);
      const wasActive = state?.active === true;
      try {
        const value = await client.grantSessionAdminAccess(session.workspaceId, session.id, {
          durationHours: durationHours(duration),
        });
        setState(value);
        toast.success(wasActive ? "Admin access updated" : "This session has admin access", {
          description: wasActive
            ? endsText(value.expiresAt)
            : `Its agent can use it from its next message. ${endsText(value.expiresAt)}.`,
        });
      } finally {
        setBusy(false);
      }
    },
    [client, session.id, session.workspaceId, state?.active],
  );

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

/** "Ends at 21:30", "Ends tomorrow at 09:00", "Ends Oct 14 at 09:00" or "No time limit". */
export function endsText(expiresAt: string | null, now: Date = new Date()): string {
  if (!expiresAt) return "No time limit";
  const end = new Date(expiresAt);
  if (Number.isNaN(end.getTime())) return "No time limit";
  const time = end.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((day(end).getTime() - day(now).getTime()) / 86_400_000);
  if (days <= 0) return `Ends at ${time}`;
  if (days === 1) return `Ends tomorrow at ${time}`;
  const date = end.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `Ends ${date} at ${time}`;
}

function grantedByText(state: SessionAdminAccess): string {
  const name = state.grantedBy?.name;
  return name
    ? `This agent can manage what ${name} can across the organization, and acts as them.`
    : "This agent can manage what the person who gave it access can across the organization, and acts as them.";
}

/** The small shield beside the title while the session has admin access. */
export function SessionAdminAccessIndicator({
  control,
  onChangeTimeLimit,
}: {
  control: SessionAdminAccessControl;
  /** Opens the time limit dialog; shown to the person who can give access. */
  onChangeTimeLimit?: () => void;
}) {
  if (!control.state.active) return null;
  return <ActiveIndicator control={control} onChangeTimeLimit={onChangeTimeLimit} />;
}

function ActiveIndicator({
  control,
  onChangeTimeLimit,
}: {
  control: SessionAdminAccessControl;
  onChangeTimeLimit?: () => void;
}) {
  // Opening the dialog waits for the menu to close, so the menu's focus
  // restoration can't pull focus out of the dialog.
  const afterClose = useRef<(() => void) | null>(null);
  const canChange = control.state.canGrant && onChangeTimeLimit;
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
      <DropdownMenuContent
        align="start"
        className="w-72"
        onCloseAutoFocus={(event) => {
          const action = afterClose.current;
          if (!action) return;
          afterClose.current = null;
          event.preventDefault();
          action();
        }}
      >
        <div className="px-2 py-1.5 text-xs text-fg-muted">
          <p className="font-medium text-fg">Admin access is on</p>
          <p className="mt-1">{grantedByText(control.state)}</p>
          <p className="mt-1" data-session-admin-access-ends="">
            {endsText(control.state.expiresAt)}.
          </p>
        </div>
        {canChange || control.state.canRevoke ? <DropdownMenuSeparator /> : null}
        {canChange ? (
          <DropdownMenuItem
            disabled={control.busy}
            onSelect={() => {
              afterClose.current = onChangeTimeLimit;
            }}
          >
            Change time limit…
          </DropdownMenuItem>
        ) : null}
        {control.state.canRevoke ? (
          <DropdownMenuItem disabled={control.busy} onSelect={() => control.revoke()}>
            Turn off admin access
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Gives this session admin access, or changes how long it lasts while it is on. */
export function GrantSessionAdminAccessDialog({
  control,
  open,
  onOpenChange,
}: {
  control: SessionAdminAccessControl;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const changing = control.state.active;
  const [duration, setDuration] = useState<AdminAccessDuration>("1");
  useEffect(() => {
    if (open) setDuration("1");
  }, [open]);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={changing ? "Change the time limit" : "Give this session admin access?"}
      description={
        changing
          ? "The new limit for admin access starts now."
          : "Its agent can then manage what you can across the organization: sessions in every workspace, settings, connections and people. Everything it does runs as you. You can turn it off at any time from the shield beside the title."
      }
      submitLabel={changing ? "Save" : "Give admin access"}
      pendingLabel={changing ? "Saving…" : "Giving access…"}
      initialFocus="cancel"
      onSubmit={async () => {
        await control.grant(duration);
      }}
      onSubmitted={() => onOpenChange(false)}
    >
      <FieldStack>
        <Field label="How long" group hint={durationHint(duration)}>
          <SegmentedControl
            fullWidth
            options={ADMIN_ACCESS_DURATIONS}
            value={duration}
            onValueChange={setDuration}
          />
        </Field>
      </FieldStack>
    </FormDialog>
  );
}

function durationHint(duration: AdminAccessDuration): string {
  if (duration === "none") return "It stays on until you turn it off.";
  const hours = durationHours(duration)!;
  return `${endsText(new Date(Date.now() + hours * 3_600_000).toISOString())}.`;
}
