import type { BillingCreditNotification, Workspace } from "@opengeni/sdk";
import { CreditCardIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { billingInboxActionPath, billingInboxCopy } from "@opengeni/react/app/lib/inbox-billing";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { DropdownMenuItem } from "@opengeni/react/ui/dropdown-menu";
import { LogoTile } from "@opengeni/react/ui/logo-tile";
import { MoreMenu, RowButton } from "@opengeni/react/ui/page-actions";
import { RelativeTime } from "@opengeni/react/ui/relative-time";
import { Section } from "@opengeni/react/ui/section";

/** Real organization notices, kept separate from chat rows and chat actions. */
export function BillingInboxSection({
  notifications,
  workspaces,
  markRead,
  onManageBilling,
}: {
  notifications: BillingCreditNotification[];
  workspaces: Pick<Workspace, "id" | "accountId">[];
  markRead: (notice: BillingCreditNotification) => Promise<void>;
  onManageBilling: (path: string) => void;
}) {
  if (notifications.length === 0) return null;
  return (
    <Section title="Billing">
      <ul
        aria-label="Billing notifications"
        className="-mx-3 my-0 flex min-w-0 list-none flex-col p-0 [&>li+li]:before:absolute [&>li+li]:before:inset-x-3 [&>li+li]:before:top-0 [&>li+li]:before:h-px [&>li+li]:before:bg-border [&>li+li]:before:content-['']"
      >
        {notifications.map((notice) => (
          <BillingInboxRow
            key={notice.id}
            notice={notice}
            path={billingInboxActionPath(notice, workspaces)}
            markRead={markRead}
            onManageBilling={onManageBilling}
          />
        ))}
      </ul>
    </Section>
  );
}

function BillingInboxRow({
  notice,
  path,
  markRead,
  onManageBilling,
}: {
  notice: BillingCreditNotification;
  path: string | null;
  markRead: (notice: BillingCreditNotification) => Promise<void>;
  onManageBilling: (path: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const copy = billingInboxCopy(notice);
  const read = async () => {
    if (busy || notice.read) return;
    setBusy(true);
    try {
      await markRead(notice);
    } catch (error) {
      toast.error(userErrorText(error, "Couldn't mark this notice read. Try again."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="relative flex min-w-0 gap-3 rounded-[10px] px-3 py-3.5 hover:bg-hover">
      <span className="relative mt-0.5 shrink-0 self-start">
        <LogoTile icon={<CreditCardIcon />} />
        {!notice.read ? (
          <span
            aria-label="Unread billing notice"
            className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-status-waiting ring-2 ring-canvas"
          />
        ) : null}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-5 text-fg">{copy.title}</p>
        <p className="mt-0.5 text-sm leading-5 text-fg-muted">{copy.body}</p>
        <div className="mt-1 text-xs text-fg-subtle">
          <RelativeTime date={notice.createdAt} />
        </div>
        {path ? (
          <RowButton asChild className="mt-3">
            <a
              href={path}
              onClick={(event) => {
                void read();
                if (
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                // Keep ordinary navigation in the app so unloading the document
                // cannot cancel the billing acknowledgement request.
                event.preventDefault();
                onManageBilling(path);
              }}
            >
              Manage billing
            </a>
          </RowButton>
        ) : null}
      </div>
      {!notice.read ? (
        <div className="shrink-0 self-start">
          <MoreMenu label={`More actions for ${copy.title}`} quiet disabled={busy}>
            <DropdownMenuItem onSelect={() => void read()}>Mark as read</DropdownMenuItem>
          </MoreMenu>
        </div>
      ) : null}
    </li>
  );
}
