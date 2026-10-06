import { expect, test } from "bun:test";
import { acquireSharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  configureSandboxV2AdmissionPolicy,
  createDb,
  createSession,
  findSandboxMachine,
  submitHumanPromptInTransaction,
  updateWorkspaceSettings,
  withWorkspaceSubjectSessionActivityRls,
  type SessionActivityDatabase,
} from "@opengeni/db";
import type {
  MachineBackend,
  MachineExecTransport,
  TransitionProof,
} from "@opengeni/runtime/sandbox";
import { mutateSessionControlInTransaction } from "../../db/src/session-control";
import { establishSandboxV2MachineForAttempt } from "../src/sandbox-v2-turn";

// Ordinary lifecycle contract fixture. It performs no live provider calls and
// does not qualify guest execution isolation, durability or provider billing.
(process.env.OPENGENI_REQUIRE_REAL_DB === "1" ? test : test.skip)(
  "PostgreSQL turn establishment retains lifecycle identity and exact attempt ownership",
  async () => {
    const fixture = await acquireSharedTestDatabase("sandbox-v2-turn");
    if (!fixture) throw new Error("Turn establishment requires disposable PostgreSQL");
    const client = createDb(fixture.appUrl);
    try {
      const suffix = crypto.randomUUID();
      const access = await bootstrapWorkspace(client.db, {
        accountExternalSource: "test",
        accountExternalId: `account-${suffix}`,
        accountName: "Synthetic turn establishment",
        workspaceExternalSource: "test",
        workspaceExternalId: `workspace-${suffix}`,
        workspaceName: "Synthetic turn establishment",
        subjectId: `subject-${suffix}`,
      });
      const grant = access.workspaceGrants[0]!;
      const workspaceId = grant.workspaceId!;
      const createInput = {
        accountId: grant.accountId,
        workspaceId,
        initialMessage: "synthetic",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium" as const,
        latencyMode: "standard" as const,
        sandboxBackend: "docker" as const,
      };
      const legacy = await createSession(client.db, createInput);
      expect(
        await establishSandboxV2MachineForAttempt(
          client.db,
          {
            accountId: grant.accountId,
            workspaceId,
            sessionId: legacy.id,
            turnId: crypto.randomUUID(),
            attemptId: crypto.randomUUID(),
            executionGeneration: 1,
          },
          new Map(),
          { idleGraceMs: 0 },
        ),
      ).toEqual({ engine: "legacy" });
      configureSandboxV2AdmissionPolicy(client.db, {
        enabled: true,
        qualifiedBackends: new Set(["docker"]),
      });
      await updateWorkspaceSettings(client.db, workspaceId, { sandboxV2Enabled: true });
      const session = await createSession(client.db, createInput);
      await withWorkspaceSubjectSessionActivityRls(client.db, workspaceId, grant.subjectId, (db) =>
        db.transaction((tx) =>
          submitHumanPromptInTransaction(tx as unknown as SessionActivityDatabase, {
            accountId: grant.accountId,
            workspaceId,
            sessionId: session.id,
            subjectId: grant.subjectId,
            actor: { type: "human", subjectId: grant.subjectId },
            operationKey: crypto.randomUUID(),
            delivery: "send",
            text: "synthetic work",
            resources: [],
            reasoningEffortFallback: "low",
            source: "user",
          }),
        ),
      );
      const attemptId = crypto.randomUUID();
      const claimed = await claimSessionWorkForAttempt(client.db, workspaceId, {
        sessionId: session.id,
        workflowId: `session-${session.id}`,
        workflowRunId: crypto.randomUUID(),
        attemptId,
        dispatchId: `dispatch-${crypto.randomUUID()}`,
        trigger: { kind: "next" },
      });
      if (claimed.action !== "claimed") throw new Error("Synthetic turn was not claimed");
      const context = {
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        turnId: claimed.turn.id,
        executionGeneration: claimed.turn.executionGeneration,
        attemptId,
      };
      const scope = {
        accountId: grant.accountId,
        workspaceId,
        sandboxGroupId: session.sandboxGroupId,
      };
      await expect(
        establishSandboxV2MachineForAttempt(client.db, context, new Map(), { idleGraceMs: 0 }),
      ).rejects.toThrow("Workspace compute is unavailable");
      expect((await findSandboxMachine(client.db, scope))!.demands).toEqual([]);

      const mutations: string[] = [];
      const proofs = new Map<string, TransitionProof>();
      const diskLineage = crypto.randomUUID();
      const instance = {
        id: `synthetic-${crypto.randomUUID()}`,
        bootId: "a".repeat(64),
        diskLineage,
      };
      const disk = { kind: "synthetic", diskLineage };
      const backend: MachineBackend = {
        provider: "docker",
        dispatch: async (_machine, transition) => {
          mutations.push(transition.kind);
          const proof: TransitionProof = {
            transitionId: transition.id,
            outcome: "settled",
            state: transition.kind === "create" ? "suspended" : "running",
            instance: transition.kind === "create" ? null : instance,
            disk,
          };
          proofs.set(transition.id, proof);
          if (transition.kind === "create") throw new Error("Synthetic lost create reply");
          return proof;
        },
        reconcile: async (_machine, transition) =>
          proofs.get(transition.id) ?? { outcome: "unknown" },
      };
      let observations = 0;
      const transport: MachineExecTransport = {
        exec: async (request) => {
          expect(request.instanceId).toBe(instance.id);
          expect(request.argv.at(-1)).toBe("capabilities");
          observations++;
          return {
            exitCode: 0,
            stdout: Buffer.from(
              JSON.stringify({
                protocol: "opengeni-run-v1",
                bootId: instance.bootId,
                supervision: "native-subreaper-v1",
                stdin: true,
                pty: true,
              }),
            ),
          };
        },
      };
      const providers = new Map([["docker", { backend, transport }]]);
      const [first, second] = await Promise.all([
        establishSandboxV2MachineForAttempt(client.db, context, providers, { idleGraceMs: 0 }),
        establishSandboxV2MachineForAttempt(client.db, context, providers, { idleGraceMs: 0 }),
      ]);
      if (first.engine !== "machine-v2" || second.engine !== "machine-v2")
        throw new Error("Retained engine changed");
      expect(mutations).toEqual(["create", "resume"]);
      expect(first.authority).toEqual(second.authority);
      expect(first.capabilities).toEqual({ stdin: true, pty: true });
      expect(await first.releaseRevoked()).toBe(false);
      expect((await findSandboxMachine(client.db, scope))!.demands).toHaveLength(1);
      configureSandboxV2AdmissionPolicy(client.db, {
        enabled: false,
        qualifiedBackends: new Set(),
      });
      await updateWorkspaceSettings(client.db, workspaceId, { sandboxV2Enabled: false });
      expect(
        (
          await establishSandboxV2MachineForAttempt(client.db, context, providers, {
            idleGraceMs: 0,
          })
        ).engine,
      ).toBe("machine-v2");
      expect(mutations).toEqual(["create", "resume"]);
      await withWorkspaceSubjectSessionActivityRls(client.db, workspaceId, grant.subjectId, (db) =>
        db.transaction((tx) =>
          mutateSessionControlInTransaction(tx as unknown as SessionActivityDatabase, {
            accountId: grant.accountId,
            workspaceId,
            sessionId: session.id,
            actor: { type: "human", subjectId: grant.subjectId },
            operationKey: crypto.randomUUID(),
            action: "pause",
          }),
        ),
      );
      const before = observations;
      await expect(
        first.transport.exec({ instanceId: instance.id, argv: ["capabilities"] }),
      ).rejects.toThrow("authority rejected");
      expect(observations).toBe(before);
      expect(await first.releaseRevoked()).toBe(true);
      expect(await second.releaseRevoked()).toBe(false);
    } finally {
      await client.close();
      await fixture.release();
    }
  },
  180_000,
);
