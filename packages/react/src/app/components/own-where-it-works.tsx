import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { OwnResourceReachKind, OwnResourceReachWorkspace } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { Button } from "../../ui/button";
import { DetailSection } from "../../ui/detail-sheet";
import { Notice } from "../../ui/notice";
import { SettingRow, SettingRowGroup } from "../../ui/setting-row";
import { Skeleton } from "../../ui/skeleton";
import { Switch } from "../../ui/switch";
import { userErrorText } from "../../ui/api-error";

/**
 * "Where it works" for your own login, model plan or machine: each workspace
 * you belong to in the organization, with a switch for whether it works there
 * for your own messages. Nobody else's messages ever use it. Logins and plans
 * always work in your Personal workspace; a machine can be turned off there too.
 */
export type OwnReachClient = Pick<
  OpenGeniBrowserClient,
  "getOwnResourceReach" | "setOwnResourceReach"
>;

export type OwnReachTarget = {
  client: OwnReachClient;
  /** The workspace the page is in. */
  workspaceId: string;
  resourceKind: OwnResourceReachKind;
  resourceId: string;
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
}: OwnReachTarget) {
  const [state, setState] = useState<ReachState>({ status: "loading" });
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});
  const [attempt, setAttempt] = useState(0);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
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
      replaceRow(target, (each) => ({ ...each, on }));
      setRowErrors(({ [target]: _cleared, ...rest }) => rest);
      setPending((now) => new Set(now).add(target));
      try {
        const saved = await client.setOwnResourceReach(target, { resourceKind, resourceId, on });
        // `current` is about the page, not the workspace the change was made in.
        if (live.current)
          replaceRow(target, (each) => ({ ...saved.workspace, current: each.current }));
      } catch (error) {
        if (!live.current) return;
        replaceRow(target, (each) => ({ ...each, on: row.on }));
        setRowErrors((now) => ({
          ...now,
          [target]: userErrorText(error, "Couldn't change this. Try again."),
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
    [client, pending, replaceRow, resourceId, resourceKind],
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

function rowDescription(row: OwnResourceReachWorkspace): string | undefined {
  if (row.alwaysOn) return "Your Personal workspace. It always works here.";
  const where = row.personal ? "Your Personal workspace" : row.current ? "This workspace" : null;
  const locked = row.canChange ? null : "You can't add your own things here";
  const parts = [where, locked].filter((part): part is string => part !== null);
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
}: {
  /** The login, plan or machine, for the switches' accessible names. */
  name: string;
  reach: ReturnType<typeof useOwnResourceReach>;
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
          description={rowDescription(row)}
          error={rowErrors[row.workspaceId]}
          control={
            <Switch
              aria-label={`Use ${name} in ${row.name}`}
              checked={row.on}
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
