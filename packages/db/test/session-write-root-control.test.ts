import { expect, test } from "bun:test";
import type { Database } from "../src/database";
import {
  evaluateSessionWriteAdmissionControl,
  type WorkspaceControlRow,
} from "../src/session-control";

type Locked = NonNullable<
  NonNullable<Parameters<typeof evaluateSessionWriteAdmissionControl>[3]>["lockedSession"]
>;
const workspaceId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
const workspace: WorkspaceControlRow = {
  workspaceId,
  accountId: crypto.randomUUID(),
  revision: 19,
  workspaceState: "active",
  workspacePauseRevision: null,
  timerId: null,
  timerAction: null,
  timerDueAt: null,
  timerPauseForSeconds: null,
  timerPauseRevision: null,
  reason: null,
  changedBy: null,
  changedAt: null,
};
const locked: Locked = {
  id: sessionId,
  workspaceId,
  parentSessionId: null,
  directControlState: "active",
  directPauseRevision: null,
  subtreeRunOverrideRevision: null,
  controlVersion: 23,
};

async function compare(row: Locked, control: WorkspaceControlRow) {
  let reads = 0;
  // The reference takes the unchanged recursive evaluator and its complete
  // control projection. Only its SQL boundary is supplied with a root row.
  const db = {
    execute: async () => {
      reads++;
      return [
        {
          targetId: row.id,
          sessionId: row.id,
          parentSessionId: row.parentSessionId,
          title: "Root",
          directState: row.directControlState,
          directPauseRevision: row.directPauseRevision,
          subtreeRunOverrideRevision: row.subtreeRunOverrideRevision,
          controlVersion: row.controlVersion,
          directControlChangedBy: null,
          directControlReason: null,
          directControlChangedAt: null,
          depth: 0,
          cycle: false,
        },
      ];
    },
  } as unknown as Database;
  const outcome = async (reuse: boolean) => {
    try {
      return await evaluateSessionWriteAdmissionControl(db, workspaceId, sessionId, {
        workspaceControl: control,
        ...(reuse ? { lockedSession: row } : {}),
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { name: error.name, message: error.message };
    }
  };
  const reference = await outcome(false);
  expect(reads).toBe(1);
  expect(await outcome(true)).toEqual(reference);
  expect(reads).toBe(1);
}

test("locked root admission retains recursive pause precedence and revision validation", async () => {
  for (const workspaceState of ["active", "paused"]) {
    for (const workspacePauseRevision of [null, 0, 10, 20]) {
      for (const directControlState of ["active", "paused"]) {
        for (const directPauseRevision of [null, 0, 10, 20]) {
          for (const subtreeRunOverrideRevision of [null, 0, 9, 10, 11, 21]) {
            await compare(
              { ...locked, directControlState, directPauseRevision, subtreeRunOverrideRevision },
              { ...workspace, workspaceState, workspacePauseRevision },
            );
          }
        }
      }
    }
  }
  for (const value of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    for (const key of [
      "directPauseRevision",
      "subtreeRunOverrideRevision",
      "controlVersion",
    ] as const) {
      await compare({ ...locked, [key]: value }, workspace);
    }
    for (const key of ["revision", "workspacePauseRevision"] as const) {
      await compare(locked, { ...workspace, [key]: value });
    }
  }
});

test("a supplied locked row cannot cross session or workspace scope", async () => {
  const db = {
    execute: () => {
      throw new Error("Unexpected query");
    },
  } as unknown as Database;
  for (const row of [
    { ...locked, id: crypto.randomUUID() },
    { ...locked, workspaceId: crypto.randomUUID() },
  ]) {
    await expect(
      evaluateSessionWriteAdmissionControl(db, workspaceId, sessionId, {
        workspaceControl: workspace,
        lockedSession: row,
      }),
    ).rejects.toThrow("Locked session does not match write admission scope");
  }
});
