import { expect, test } from "bun:test";
import {
  RoutingMutationOutcomeUnknownError,
  RoutingSandboxSession,
} from "../src/sandbox/routing/routing-session";

type Scenario = "success" | "nonzero" | "observation-loss";

function request() {
  return {
    operationId: crypto.randomUUID(),
    destinationPath: "attachments/one.bin",
    overwrite: false,
    mayReplaceExisting: false,
    createParents: false,
    sizeBytes: 3,
    sha256: "a".repeat(64),
    source: {
      url: "https://files.example.test/one?signature=synthetic-authority",
      expiresAt: "2030-01-02T03:04:05.000Z",
    },
  };
}

function fixture(scenario: Scenario) {
  const events: string[] = [];
  const admissions: string[] = [];
  const retained: Array<{ providerSessionId: number; purpose?: string }> = [];
  const settled: Array<{ providerSessionId: number; exitCode: number | null }> = [];
  const starts: Array<{ command: string; marker: string }> = [];
  const controlInputs: string[] = [];
  const privateWrites: string[] = [];
  const privateDeletes: string[] = [];
  let failFirstObservation = scenario === "observation-loss";
  let cancelled = false;
  let admissionId = 0;

  const session = {
    exec: async (args: unknown) => {
      const command = (args as { cmd: string }).cmd;
      if (command.includes("__OPENGENI_FS_CONFINED_OK__")) {
        return { stdout: "__OPENGENI_FS_CONFINED_OK__", stderr: "", exitCode: 0 };
      }
      const marker = command.match(/__OPENGENI_WORKSPACE_IMPORT_[0-9a-f]+_OK__/u)?.[0];
      if (!marker) throw new Error("unexpected non-Modal exec command");
      starts.push({ command, marker });
      return { stdout: "start output", stderr: "", sessionId: 23, exitCode: null };
    },
    execCommand: async () => {
      throw new Error("non-Modal composite start must preserve the native exec surface");
    },
    writeStdin: async (args: unknown) => {
      const input = args as { sessionId: number; chars?: string };
      expect(input.sessionId).toBe(23);
      if (input.chars === "\u0003") {
        controlInputs.push(input.chars);
        cancelled = true;
        return "Process running with session ID 23\n\nOutput:\n";
      }
      if (failFirstObservation) {
        failFirstObservation = false;
        throw new Error("provider control transport unavailable");
      }
      const exitCode = cancelled ? 130 : scenario === "nonzero" ? 7 : 0;
      const output = exitCode === 0 ? `${starts[0]!.marker}\tcreated` : "";
      return `Process exited with code ${exitCode}\n\nOutput:\n${output}`;
    },
    writePlacementPrivate: async (args: unknown) => {
      privateWrites.push((args as { path: string }).path);
    },
    deletePlacementPrivate: async (path: string) => {
      privateDeletes.push(path);
    },
  };
  const backend = { session, sandboxId: "machine-1", kind: "selfhosted" };
  const route = new RoutingSandboxSession({
    defaultResolved: backend,
    readPointer: async () => ({ activeSandboxId: "machine-1", activeEpoch: 1 }),
    resolveActiveBackend: async () => backend,
    beforeMutation: async ({ op }) => {
      admissions.push(op);
      return { handle: ++admissionId };
    },
    providerCommandHandle: (admission) => (admission as { handle: number }).handle,
    afterMutation: async ({ op, outcome, retainedProcess, retainedProcessPurpose }) => {
      if (retainedProcess) {
        retained.push({
          providerSessionId: retainedProcess.providerSessionId,
          ...(retainedProcessPurpose ? { purpose: retainedProcessPurpose } : {}),
        });
        events.push("child-promoted");
      } else {
        events.push(`${op}:${outcome}`);
      }
    },
    settleProcess: async ({ process, proof }) => {
      settled.push({ providerSessionId: process.providerSessionId, exitCode: proof.exitCode });
      events.push(`child-terminal:${proof.exitCode}`);
    },
  });
  return {
    route,
    events,
    admissions,
    retained,
    settled,
    starts,
    controlInputs,
    privateWrites,
    privateDeletes,
  };
}

test("non-Modal composite import retains and settles the exact child before outer success", async () => {
  const f = fixture("success");
  const receipt = await f.route.importWorkspaceFileOnResolvedBackend({
    request: request(),
    workspaceRoot: "/workspace",
    revision: 0,
  });

  expect(receipt).toMatchObject({ destinationPath: "attachments/one.bin", replayed: false });
  expect(f.admissions).toEqual(["importWorkspaceFile", "exec"]);
  expect(f.starts).toHaveLength(1);
  expect(f.retained).toEqual([{ providerSessionId: 23, purpose: "synchronous_filesystem" }]);
  expect(f.settled).toEqual([{ providerSessionId: 23, exitCode: 0 }]);
  expect(f.events).toEqual([
    "child-promoted",
    "child-terminal:0",
    "importWorkspaceFile:resolved",
  ]);
  expect(f.privateWrites).toHaveLength(1);
  expect(f.privateDeletes).toHaveLength(1);
  expect(f.route.hasRetainedProcess(23)).toBe(false);
});

test("non-Modal composite import settles an eventual nonzero child before rejecting the outer admission", async () => {
  const f = fixture("nonzero");
  await expect(
    f.route.importWorkspaceFileOnResolvedBackend({
      request: request(),
      workspaceRoot: "/workspace",
      revision: 0,
    }),
  ).rejects.toThrow("Workspace file import is temporarily unavailable");

  expect(f.starts).toHaveLength(1);
  expect(f.settled).toEqual([{ providerSessionId: 23, exitCode: 7 }]);
  expect(f.events).toEqual([
    "child-promoted",
    "child-terminal:7",
    "importWorkspaceFile:rejected",
  ]);
  expect(f.route.hasRetainedProcess(23)).toBe(false);
});

test("non-Modal observation loss hands off the exact child, then cancellation drains its terminal proof", async () => {
  const f = fixture("observation-loss");
  const error = await f.route
    .importWorkspaceFileOnResolvedBackend({
      request: request(),
      workspaceRoot: "/workspace",
      revision: 0,
    })
    .catch((caught) => caught);

  expect(error).toBeInstanceOf(RoutingMutationOutcomeUnknownError);
  expect(error.retainedProcess.providerSessionId).toBe(23);
  expect(f.admissions).toEqual(["importWorkspaceFile", "exec"]);
  expect(f.starts).toHaveLength(1);
  expect(f.events).toEqual(["child-promoted", "importWorkspaceFile:resolved"]);
  expect(f.route.hasRetainedProcess(23)).toBe(true);
  expect(f.settled).toEqual([]);
  expect(f.privateDeletes).toEqual([]);

  await f.route.writeStdinForProcessControl({ sessionId: 23, chars: "\u0003" });
  expect(f.controlInputs).toEqual(["\u0003"]);
  expect(f.route.hasRetainedProcess(23)).toBe(true);
  expect(f.settled).toEqual([]);

  await f.route.writeStdinForProcessControl({ sessionId: 23, chars: "" });
  expect(f.settled).toEqual([{ providerSessionId: 23, exitCode: 130 }]);
  expect(f.route.hasRetainedProcess(23)).toBe(false);
  expect(f.starts).toHaveLength(1);
});
