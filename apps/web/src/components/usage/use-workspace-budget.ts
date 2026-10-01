import { OpenGeniApiError, type OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import {
  clearWorkspaceAllowance,
  getAllUsage,
  getMyUsage,
  getWorkspaceAllowanceState,
  setMemberAllowance,
  setWorkspaceAllowance,
  type MemberAllowanceDefault,
  type MemberAllowanceRule,
  type MemberAllowanceUsage,
  type WorkspaceAllowanceState,
  type WorkspaceUsageResponse,
} from "@opengeni/sdk/usage-allowances";
import { useCallback, useEffect, useRef, useState } from "react";

export type Loaded<T> = { value: T | null; error: Error | null; loading: boolean };

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function isForbidden(error: unknown): boolean {
  return error instanceof OpenGeniApiError && (error.status === 403 || error.status === 404);
}

/** One sentence for a failed budget write: a stale version reads as "someone changed it". */
export function budgetWriteError(error: unknown, subject: "budget" | "limit"): Error {
  if (error instanceof OpenGeniApiError) {
    if (error.status === 409 && /not enabled/i.test(error.message)) {
      return new Error(
        "Usage budgets aren't turned on for this deployment yet. Ask whoever runs it to enable them.",
      );
    }
    if (error.status === 409) {
      return new Error(
        subject === "budget"
          ? "Someone else changed this budget. We loaded the latest; review it and save again."
          : "This limit changed elsewhere. We loaded the latest; try again.",
      );
    }
    if (error.status === 403) {
      return new Error(
        subject === "budget"
          ? "Only organization owners can change workspace budgets."
          : "Only workspace admins can change member limits.",
      );
    }
    if (error.outcomeUnknown) {
      return new Error("We couldn't confirm the change. Reload to see whether it saved.");
    }
  }
  return asError(error);
}

export type BudgetDraft = {
  includedCredits: number;
  anchorDay: number;
  memberDefault: MemberAllowanceDefault;
};

/**
 * One workspace's budget: its configuration (owners, workspace admins), the
 * aggregate this period, and, when `roster` is on, every member's usage.
 * Writes use the exact version just read; a conflict reloads before failing.
 */
export function useWorkspaceBudget(
  client: OpenGeniBrowserClient,
  workspaceId: string,
  options: { roster: boolean; budget: boolean },
) {
  const [allowance, setAllowance] = useState<Loaded<WorkspaceAllowanceState>>({
    value: null,
    error: null,
    loading: options.budget,
  });
  const [usage, setUsage] = useState<Loaded<WorkspaceUsageResponse>>({
    value: null,
    error: null,
    loading: true,
  });
  const [rosterDenied, setRosterDenied] = useState(false);
  const generation = useRef(0);
  const { roster, budget } = options;

  const reload = useCallback(async () => {
    const ticket = ++generation.current;
    setAllowance((current) => ({ ...current, loading: budget }));
    setUsage((current) => ({ ...current, loading: true }));
    let denied = false;
    const [state, read] = await Promise.allSettled([
      budget ? getWorkspaceAllowanceState(client, workspaceId) : Promise.resolve(null),
      roster
        ? getAllUsage(client, workspaceId).catch((error: unknown) => {
            // Without roster authority, still show the workspace aggregate.
            if (!isForbidden(error)) throw error;
            denied = true;
            return getMyUsage(client, workspaceId);
          })
        : getMyUsage(client, workspaceId),
    ]);
    if (ticket !== generation.current) return;
    setRosterDenied(denied);
    setAllowance(
      state.status === "fulfilled"
        ? { value: state.value, error: null, loading: false }
        : { value: null, error: asError(state.reason), loading: false },
    );
    setUsage(
      read.status === "fulfilled"
        ? { value: read.value, error: null, loading: false }
        : { value: null, error: asError(read.reason), loading: false },
    );
  }, [budget, client, roster, workspaceId]);

  useEffect(() => {
    void reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);

  const saveBudget = useCallback(
    async (draft: BudgetDraft) => {
      const version = allowance.value?.version ?? 0;
      try {
        await setWorkspaceAllowance(client, workspaceId, {
          includedCredits: draft.includedCredits,
          period: "monthly",
          anchorDay: draft.anchorDay,
          memberDefault: draft.memberDefault,
          // Keep thresholds the owner may have set elsewhere (API/SDK).
          ...(allowance.value?.config?.thresholds
            ? { thresholds: allowance.value.config.thresholds }
            : {}),
          expectedVersion: version,
        });
      } catch (error) {
        if (error instanceof OpenGeniApiError && error.status === 409) await reload();
        throw budgetWriteError(error, "budget");
      }
      await reload();
    },
    [allowance.value, client, reload, workspaceId],
  );

  const removeBudget = useCallback(async () => {
    const version = allowance.value?.version ?? 0;
    try {
      await clearWorkspaceAllowance(client, workspaceId, {
        expectedVersion: version,
        operationId: crypto.randomUUID(),
      });
    } catch (error) {
      if (error instanceof OpenGeniApiError && error.status === 409) await reload();
      throw budgetWriteError(error, "budget");
    }
    await reload();
  }, [allowance.value, client, reload, workspaceId]);

  const setMemberRule = useCallback(
    async (member: MemberAllowanceUsage, rule: MemberAllowanceRule) => {
      try {
        await setMemberAllowance(client, workspaceId, member.subjectId, {
          rule,
          expectedVersion: member.version,
        });
      } catch (error) {
        if (error instanceof OpenGeniApiError && error.status === 409) await reload();
        throw budgetWriteError(error, "limit");
      }
      await reload();
    },
    [client, reload, workspaceId],
  );

  return { allowance, usage, rosterDenied, reload, saveBudget, removeBudget, setMemberRule };
}
