import { Button } from "@/components/ui/button";
import { DetailFact, DetailFacts } from "@/components/ui/detail-sheet";
import type { ScheduledTask, ScheduledTaskAccountPlan } from "@/types";

type PlanConnector = ScheduledTaskAccountPlan["connectors"][number];

/** The sentence under the Accounts heading. */
export function scheduleAccountsDescription(
  task: Pick<ScheduledTask, "runMode">,
  plan: ScheduledTaskAccountPlan,
): string {
  if (task.runMode === "existing_session") {
    return "Runs use the chat's connectors with your current accounts.";
  }
  const pinned = plan.connectors.some((connector) => connector.mode === "pinned");
  return pinned
    ? "Pinned connectors use only the accounts you chose. The rest use your current accounts at each run."
    : "Each run uses your current accounts, so connecting or removing one counts from the next run.";
}

function consequence(name: string, skipsRuns: boolean): string {
  return skipsRuns ? "Runs are skipped until you change it." : `Runs go without ${name}.`;
}

/** What one connector would act as, and why, in two short lines. */
export function scheduleAccountRowText(
  connector: PlanConnector,
  options: { skipsRuns: boolean },
): { accounts: string[]; note: string; stale: boolean } {
  const accounts = connector.accounts.map((account) => account.label);
  if (connector.mode === "default") {
    return accounts.length > 0
      ? { accounts, note: "Your current accounts", stale: false }
      : {
          accounts: [],
          note: `No account connected. Runs go without ${connector.name}.`,
          stale: false,
        };
  }
  const gone = connector.unavailablePins.length;
  if (gone === 0) return { accounts, note: "Pinned", stale: false };
  if (accounts.length === 0) {
    return {
      accounts: [],
      note: `${gone === 1 ? "The pinned account" : "The pinned accounts"} can no longer be used. ${consequence(connector.name, options.skipsRuns)}`,
      stale: true,
    };
  }
  return {
    accounts,
    note: `Pinned. ${gone === 1 ? "One pinned account" : `${gone} pinned accounts`} can no longer be used.`,
    stale: true,
  };
}

/**
 * Which account each connector of a schedule would use if it ran now, from
 * the server's live account plan. Only the owner receives the plan. A pin
 * that can no longer be used can go back to the owner's current accounts in
 * one step; a working pin is a deliberate choice and changes in the editor.
 */
export function ScheduleAccounts(props: {
  plan: ScheduledTaskAccountPlan;
  skipsRuns: boolean;
  canEdit: boolean;
  busy: boolean;
  onUseCurrentAccounts: (connectorId: string) => void;
}) {
  return (
    <DetailFacts>
      {props.plan.connectors.map((connector) => {
        const row = scheduleAccountRowText(connector, { skipsRuns: props.skipsRuns });
        return (
          <DetailFact
            key={connector.id}
            label={connector.name}
            action={
              props.canEdit && row.stale ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={props.busy}
                  onClick={() => props.onUseCurrentAccounts(connector.id)}
                  aria-label={`Use your current ${connector.name} accounts`}
                  className="pointer-coarse:h-11"
                >
                  Use current accounts
                </Button>
              ) : null
            }
          >
            {row.accounts.map((label) => (
              <span key={label} className="block break-words">
                {label}
              </span>
            ))}
            <span
              className={
                row.stale
                  ? "block text-xs leading-4.5 text-danger"
                  : row.accounts.length > 0
                    ? "block text-xs leading-4.5 text-fg-muted"
                    : "block text-fg-muted"
              }
            >
              {row.note}
            </span>
          </DetailFact>
        );
      })}
    </DetailFacts>
  );
}
