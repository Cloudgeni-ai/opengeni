import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ChatClient } from "@opengeni/sdk";
import type { OwnResourceReachKind, OwnResourceReachWorkspace } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { Button } from "../../ui/button";
import { DetailSection } from "../../ui/detail-sheet";
import { Notice } from "../../ui/notice";
import { SettingRow, SettingRowGroup } from "../../ui/setting-row";
import { Skeleton } from "../../ui/skeleton";
import { Switch } from "../../ui/switch";
import { serverRefusalText, userErrorText } from "../../ui/api-error";
import { OWN_LOGIN_CONNECTOR_NEEDS_ADMIN_CODE } from "@opengeni/contracts/personal-integration-setup";

/**
 * "Where it works" for your own login, model plan or machine: each workspace
 * you belong to in the organization, with a switch for whether it works there
 * for your own messages. Nobody else's messages ever use it. Logins and plans
 * always work in your Personal workspace; a machine can be turned off there too.
 */
export type OwnReachClient = Pick<
  ChatClient<OpenGeniBrowserClient>,
  "getOwnResourceReach" | "setOwnResourceReach"
>;

export type OwnReachTarget = {
  client: OwnReachClient;
  /** The workspace the page is in. */
  workspaceId: string;
  resourceKind: OwnResourceReachKind;
  resourceId: string;
  /**
   * Rows already loaded (by "My things"): shown at once, without asking again.
   * "Try again" after a failure still reads them fresh.
   */
  initialWorkspaces?: readonly OwnResourceReachWorkspace[] | undefined;
  /**
   * Turning a login on turned its connector on in that workspace: a page
   * showing the connector reads it again.
   */
  onConnectorTurnedOn?: ((workspaceId: string) => void) | undefined;
};

type ReachState =
  | { status: "loading" }
  | { status: "absent" }
  | { status: "error"; message: string }
  | { status: "ready"; workspaces: OwnResourceReachWorkspace[] };

export const OWN_WHERE_IT_WORKS_TITLE = "Where it works";
export const OWN_WHERE_IT_WORKS_DESCRIPTION =
  "Only your own messages use it. In a shared workspace, people see what the agent does with it.";

function notFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { status?: unknown }).status === 404
  );
}

export function useOwnResourceReach({
  client,
  workspaceId,
  resourceKind,
  resourceId,
  initialWorkspaces,
  onConnectorTurnedOn,
}: OwnReachTarget) {
  const [state, setState] = useState<ReachState>(
    initialWorkspaces
      ? { status: "ready", workspaces: [...initialWorkspaces] }
      : { status: "loading" },
  );
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});
  const [attempt, setAttempt] = useState(0);
  const live = useRef(true);
  // The target the initial rows describe. Any other target, or a retry, reads.
  const seeded = useRef(initialWorkspaces ? `${workspaceId}:${resourceKind}:${resourceId}` : null);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (attempt === 0 && seeded.current === `${workspaceId}:${resourceKind}:${resourceId}`) return;
    let current = true;
    setState({ status: "loading" });
    client
      .getOwnResourceReach(workspaceId, { resourceKind, resourceId })
      .then((reach) => {
        if (current) setState({ status: "ready", workspaces: reach.workspaces });
      })
      .catch((error: unknown) => {
        if (!current) return;
        setState(
          notFound(error)
            ? { status: "absent" }
            : { status: "error", message: userErrorText(error, "Couldn't load this.") },
        );
      });
    return () => {
      current = false;
    };
  }, [attempt, client, resourceId, resourceKind, workspaceId]);

  const replaceRow = useCallback(
    (target: string, change: (row: OwnResourceReachWorkspace) => OwnResourceReachWorkspace) => {
      setState((now) =>
        now.status === "ready"
          ? {
              ...now,
              workspaces: now.workspaces.map((row) =>
                row.workspaceId === target ? change(row) : row,
              ),
            }
          : now,
      );
    },
    [],
  );

  const setOn = useCallback(
    async (row: OwnResourceReachWorkspace, on: boolean) => {
      const target = row.workspaceId;
      if (pending.has(target)) return;
      // The switch moves at once; a failure puts it back and says why.
      // Turning a login on turns its connector on too.
      replaceRow(target, ({ connectorOff, ...each }) => ({
        ...each,
        on,
        ...(connectorOff && !on ? { connectorOff } : {}),
      }));
      setRowErrors(({ [target]: _cleared, ...rest }) => rest);
      setPending((now) => new Set(now).add(target));
      try {
        const saved = await client.setOwnResourceReach(target, { resourceKind, resourceId, on });
        // `current` is about the page, not the workspace the change was made in.
        if (live.current)
          replaceRow(target, (each) => ({ ...saved.workspace, current: each.current }));
        if (on && row.connectorOff && !saved.workspace.connectorOff) onConnectorTurnedOn?.(target);
      } catch (error) {
        if (!live.current) return;
        replaceRow(target, (each) => ({ ...row, current: each.current }));
        setRowErrors((now) => ({
          ...now,
          // "Only an admin can turn <connector> on here": nothing changed.
          [target]:
            serverRefusalText(error, [OWN_LOGIN_CONNECTOR_NEEDS_ADMIN_CODE]) ??
            userErrorText(error, "Couldn't change this. Try again."),
        }));
      } finally {
        if (live.current)
          setPending((now) => {
            const next = new Set(now);
            next.delete(target);
            return next;
          });
      }
    },
    [client, onConnectorTurnedOn, pending, replaceRow, resourceId, resourceKind],
  );

  return {
    state,
    pending,
    rowErrors,
    setOn,
    retry: () => setAttempt((count) => count + 1),
  };
}

/** Nothing to choose: only your Personal workspace, where it always works. */
export function ownReachHasNothingToChoose(
  workspaces: readonly OwnResourceReachWorkspace[],
): boolean {
  return workspaces.every((row) => row.alwaysOn);
}

/** A login's connector, by what it is called. */
export type OwnLoginConnector = { name: string };

/**
 * Whether it works here: on, and for a login, its connector on here too.
 * A login on where its connector isn't reads as off; turning it on turns
 * both on, so there is one switch.
 */
export function ownReachWorksHere(row: Pick<OwnResourceReachWorkspace, "on" | "connectorOff">) {
  return row.on && !row.connectorOff;
}

function rowDescription(
  row: OwnResourceReachWorkspace,
  connector: OwnLoginConnector | undefined,
): string | undefined {
  if (row.alwaysOn) return "Your Personal workspace. It always works here.";
  const where = row.personal ? "Your Personal workspace" : row.current ? "This workspace" : null;
  const connectorOff =
    row.connectorOff && row.canChange
      ? `Not used here yet. Turning it on turns ${connector?.name ?? "its connector"} on here too`
      : null;
  const locked = row.canChange ? null : "You can't add your own things here";
  const parts = [where, connectorOff, locked].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(". ") : undefined;
}

function disabledReason(row: OwnResourceReachWorkspace): string | undefined {
  if (row.alwaysOn) return "Logins and plans can't be turned off in your Personal workspace.";
  if (!row.canChange) return "Ask this workspace's admins to let you add your own things.";
  return undefined;
}

/**
 * The workspace rows, with their loading and error states. Put it under a
 * heading; {@link OwnWhereItWorksSection} does that for detail pages and sheets.
 * Renders nothing when the thing isn't yours or there is nothing to choose.
 */
export function OwnWhereItWorks({
  name,
  reach,
  connector,
}: {
  /** The login, plan or machine, for the switches' accessible names. */
  name: string;
  reach: ReturnType<typeof useOwnResourceReach>;
  /** For a login: its connector, which turning the login on also turns on. */
  connector?: OwnLoginConnector | undefined;
}) {
  const { state, pending, rowErrors, setOn, retry } = reach;
  if (state.status === "loading") {
    return (
      <SettingRowGroup aria-busy="true" aria-label="Loading where it works">
        {[0, 1].map((key) => (
          <div key={key} className="flex items-center justify-between gap-4 py-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-5 w-9 rounded-full" />
          </div>
        ))}
      </SettingRowGroup>
    );
  }
  if (state.status === "absent") return null;
  if (state.status === "error") {
    return (
      <Notice
        tone="waiting"
        title="Couldn't load where it works"
        action={
          <Button type="button" size="sm" variant="outline" onClick={retry}>
            Try again
          </Button>
        }
      >
        {state.message}
      </Notice>
    );
  }
  return (
    <SettingRowGroup>
      {state.workspaces.map((row) => (
        <SettingRow
          key={row.workspaceId}
          label={row.name}
          description={rowDescription(row, connector)}
          error={rowErrors[row.workspaceId]}
          control={
            <Switch
              aria-label={`Use ${name} in ${row.name}`}
              checked={ownReachWorksHere(row)}
              pending={pending.has(row.workspaceId)}
              disabled={row.alwaysOn || !row.canChange}
              disabledReason={disabledReason(row)}
              onCheckedChange={(next) => void setOn(row, next)}
            />
          }
        />
      ))}
    </SettingRowGroup>
  );
}

/** "Where it works" as a detail section, for your own login, plan or machine. */
export function OwnWhereItWorksSection({ name, ...target }: OwnReachTarget & { name: string }) {
  const reach = useOwnResourceReach(target);
  if (reach.state.status === "absent") return null;
  if (reach.state.status === "ready" && ownReachHasNothingToChoose(reach.state.workspaces))
    return null;
  return (
    <DetailSection title={OWN_WHERE_IT_WORKS_TITLE} description={OWN_WHERE_IT_WORKS_DESCRIPTION}>
      <OwnWhereItWorks name={name} reach={reach} />
    </DetailSection>
  );
}

/** "Where it works" as a card, matching the cards of a machine's page. */
export function OwnWhereItWorksCard({ name, ...target }: OwnReachTarget & { name: string }) {
  const reach = useOwnResourceReach(target);
  const headingId = useId();
  if (reach.state.status === "absent") return null;
  if (reach.state.status === "ready" && ownReachHasNothingToChoose(reach.state.workspaces))
    return null;
  return (
    <section
      aria-labelledby={headingId}
      data-own-where-it-works
      className="flex min-w-0 flex-col gap-1 rounded-og-lg border border-og-border bg-og-surface-1 px-4 pt-3 pb-1 shadow-og-sm"
    >
      <h2 id={headingId} className="m-0 text-sm leading-5 font-semibold text-og-fg">
        {OWN_WHERE_IT_WORKS_TITLE}
      </h2>
      <p className="m-0 text-xs leading-4.5 text-og-fg-muted">{OWN_WHERE_IT_WORKS_DESCRIPTION}</p>
      <OwnWhereItWorks name={name} reach={reach} />
    </section>
  );
}
