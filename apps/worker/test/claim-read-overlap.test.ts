import { expect, test, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import * as core from "@opengeni/core";
import * as dbPorts from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { measureTurnStartupPhase } from "../src/observability-metrics";
import { claimTurnAttempt, type ClaimTurnDeps } from "../src/activities/agent-turn/claim";
import { createTurnContext } from "../src/activities/agent-turn/turn-context";
import * as capabilities from "../src/activities/capabilities";

function productionReads() {
  const source = readFileSync(
    new URL("../src/activities/agent-turn/claim.ts", import.meta.url),
    "utf8",
  );
  const parsed = parseSync("claim.ts", source);
  expect(parsed.errors).toEqual([]);
  const exported = parsed.program.body.find(
    (node) =>
      node.type === "ExportNamedDeclaration" &&
      node.declaration?.type === "FunctionDeclaration" &&
      node.declaration.id?.name === "claimTurnAttempt",
  );
  if (
    exported?.type !== "ExportNamedDeclaration" ||
    exported.declaration?.type !== "FunctionDeclaration"
  )
    throw new Error("Missing claimTurnAttempt");
  const declarations = exported.declaration.body!.body.filter(
    (node) =>
      node.type === "VariableDeclaration" &&
      node.declarations.some((d) => {
        const ids = d.id.type === "ArrayPattern" ? d.id.elements : [d.id];
        return ids.some(
          (id) =>
            id?.type === "Identifier" &&
            [
              "session",
              "mcpSettings",
              "installedApiIntegrations",
              "credentialSubjectId",
              "fileAuthoritySubjectId",
            ].includes(id.name),
        );
      }),
  );
  const first = declarations[0]!;
  const last = declarations.at(-1)!;
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
    source.slice(first.start, last.end),
  );
  return new Function(
    "ports",
    "db",
    "input",
    "turn",
    "deploymentCatalogSettings",
    `return (async () => {
    const observability = {};
    const { requireSession, settingsWithEnabledCapabilityMcpServers, credentialSubjectIdForTurnInitiator, measureTurnStartupPhase, afterReads } = ports;
    ${code}
    await afterReads();
    return { session, mcpSettings, installedApiIntegrations, credentialSubjectId, fileAuthoritySubjectId };
  })();`,
  ) as (...args: unknown[]) => Promise<Record<string, unknown>>;
}
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
function fixture(subject: string | null) {
  const reads = [deferred(), deferred()];
  const calls: { name: string; args: unknown[] }[] = [];
  const db = {};
  const input = { workspaceId: "workspace", sessionId: "session" };
  const turn = {
    sandboxBackend: "none",
    initiatingHumanSubjectId: "file-owner",
    personalConnectionDelegations: [{ connectionId: "delegated" }],
  };
  const settings = { marker: "fresh deployment catalog" };
  const integrations = [{ marker: "resolved API" }];
  let continuations = 0;
  const ports = {
    measureTurnStartupPhase,
    credentialSubjectIdForTurnInitiator: () => subject,
    requireSession: (...args: unknown[]) => {
      calls.push({ name: "session", args });
      return reads[0]!.promise;
    },
    settingsWithEnabledCapabilityMcpServers: (...args: unknown[]) => {
      calls.push({ name: "capabilities", args });
      return reads[1]!.promise.then((value) => {
        (
          args[3] as { onResolvedApiIntegrations: (value: unknown[]) => void }
        ).onResolvedApiIntegrations(integrations);
        return value;
      });
    },
    afterReads: () => {
      continuations++;
    },
  };
  const running = productionReads()(ports, db, input, turn, settings);
  void running.catch(() => undefined);
  return {
    reads,
    calls,
    db,
    input,
    turn,
    settings,
    integrations,
    running,
    continuations: () => continuations,
  };
}

for (const subject of ["human", null]) {
  for (const first of [0, 1]) {
    test(`both fresh reads start held; subject=${subject}, completion=${first}`, async () => {
      const f = fixture(subject);
      try {
        expect(f.calls.map(({ name }) => name)).toEqual(["session", "capabilities"]);
        expect(f.calls[0]!.args).toEqual([f.db, f.input.workspaceId, f.input.sessionId]);
        expect(f.calls[1]!.args.slice(0, 3)).toEqual([f.db, f.input.workspaceId, f.settings]);
        expect(f.calls[1]!.args[3]).toMatchObject(
          subject
            ? { subjectId: subject }
            : { personalConnectionDelegations: f.turn.personalConnectionDelegations },
        );
        expect(
          Object.hasOwn(
            f.calls[1]!.args[3] as object,
            subject ? "personalConnectionDelegations" : "subjectId",
          ),
        ).toBe(false);
        f.reads[first]!.resolve(`value-${first}`);
        await Promise.resolve();
        await Promise.resolve();
        expect(f.continuations()).toBe(0);
        f.reads[1 - first]!.resolve(`value-${1 - first}`);
        expect(await f.running).toEqual({
          session: "value-0",
          mcpSettings: "value-1",
          installedApiIntegrations: f.integrations,
          credentialSubjectId: subject,
          fileAuthoritySubjectId: "file-owner",
        });
        expect(f.continuations()).toBe(1);
      } finally {
        for (const r of f.reads) r.resolve("cleanup");
        await f.running.catch(() => undefined);
      }
    });
  }
}

for (const failed of [0, 1]) {
  test(`read ${failed} rejection prevents later credential/policy continuation, including late sibling`, async () => {
    const f = fixture("human");
    const failure = new Error("scoped read failed");
    try {
      expect(f.calls).toHaveLength(2);
      f.reads[failed]!.reject(failure);
      await expect(f.running).rejects.toBe(failure);
      expect(f.continuations()).toBe(0);
      f.reads[1 - failed]!.resolve("late");
      await Promise.resolve();
      await Promise.resolve();
      expect(f.continuations()).toBe(0);
    } finally {
      for (const r of f.reads) r.resolve("cleanup");
      await f.running.catch(() => undefined);
    }
  });
}

test("actual unclaimed activity exits before either post-claim read", async () => {
  const settings = testSettings({ sandboxBackend: "none" });
  const catalog = spyOn(core, "resolveCatalogSettings").mockResolvedValue({ settings } as Awaited<
    ReturnType<typeof core.resolveCatalogSettings>
  >);
  const claim = spyOn(dbPorts, "claimSessionWorkForAttempt").mockResolvedValue({
    action: "unclaimed",
    reason: "no_work",
  } as Awaited<ReturnType<typeof dbPorts.claimSessionWorkForAttempt>>);
  const read = spyOn(dbPorts, "requireSession").mockImplementation(async () => {
    throw new Error("unclaimed read");
  });
  const capabilityRead = spyOn(
    capabilities,
    "settingsWithEnabledCapabilityMcpServers",
  ).mockImplementation(async () => {
    throw new Error("unclaimed capability read");
  });
  try {
    const result = await claimTurnAttempt({
      ...createTurnContext({ settings, cancellationRequestedAt: null }),
      settings,
      catalogSourceSettings: settings,
      db: {},
      input: {
        accountId: "account",
        workspaceId: "workspace",
        sessionId: "session",
        attemptId: "attempt",
        workflowId: "workflow",
        workflowRunId: "run",
        trigger: { kind: "next" },
      },
      dispatchId: "dispatch",
    } as ClaimTurnDeps);
    expect(result).toMatchObject({ exit: { status: "unclaimed", reason: "no_work" } });
    expect(read).not.toHaveBeenCalled();
    expect(capabilityRead).not.toHaveBeenCalled();
  } finally {
    catalog.mockRestore();
    claim.mockRestore();
    read.mockRestore();
    capabilityRead.mockRestore();
  }
});

function actualClaimFixture() {
  const settings = testSettings({ sandboxBackend: "none" });
  const context = createTurnContext({ settings, cancellationRequestedAt: null });
  const claimRead = deferred();
  const reads = [deferred(), deferred()];
  const calls: string[] = [];
  const stop = new Error("stopped at first credential gate");
  const turn = {
    id: "turn",
    executionGeneration: 1,
    sandboxBackend: "none",
    initiator: { kind: "service", subjectId: "internal" },
    personalConnectionDelegations: [],
    metadata: {},
  };
  const spies = [
    spyOn(core, "resolveCatalogSettings").mockResolvedValue({ settings } as Awaited<
      ReturnType<typeof core.resolveCatalogSettings>
    >),
    spyOn(dbPorts, "claimSessionWorkForAttempt").mockImplementation(
      async () =>
        (await claimRead.promise) as Awaited<ReturnType<typeof dbPorts.claimSessionWorkForAttempt>>,
    ),
    spyOn(dbPorts, "requireSession").mockImplementation(async () => {
      expect(context.attempt.turnId).toBe(turn.id);
      calls.push("session");
      return (await reads[0]!.promise) as Awaited<ReturnType<typeof dbPorts.requireSession>>;
    }),
    spyOn(capabilities, "settingsWithEnabledCapabilityMcpServers").mockImplementation(async () => {
      expect(context.attempt.turnId).toBe(turn.id);
      calls.push("capabilities");
      return (await reads[1]!.promise) as typeof settings;
    }),
    spyOn(dbPorts, "workspaceCodexSubscriptionActive").mockImplementation(async () => {
      calls.push("credential_gate");
      throw stop;
    }),
  ];
  const running = claimTurnAttempt({
    ...context,
    leases: { codex: { holderId: null } },
    settings,
    catalogSourceSettings: settings,
    db: {},
    input: {
      accountId: "account",
      workspaceId: "workspace",
      sessionId: "session",
      attemptId: "attempt",
      workflowId: "workflow",
      workflowRunId: "run",
      trigger: { kind: "next" },
    },
    dispatchId: "dispatch",
  } as ClaimTurnDeps);
  void running.catch(() => undefined);
  return {
    calls,
    reads,
    claimRead,
    running,
    turn,
    settings,
    stop,
    async cleanup() {
      claimRead.resolve({ action: "claimed", turn });
      reads[0]!.resolve({});
      reads[1]!.resolve(settings);
      await running.catch(() => undefined);
      for (const spy of spies) spy.mockRestore();
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

for (const first of [0, 1]) {
  test(`full claim holds ownership first and joins both reads before credential gate; completion=${first}`, async () => {
    const f = actualClaimFixture();
    try {
      await flush();
      expect(f.calls).toEqual([]);
      f.claimRead.resolve({ action: "claimed", turn: f.turn });
      await flush();
      expect(f.calls).toEqual(["session", "capabilities"]);
      f.reads[first]!.resolve(first ? f.settings : {});
      await flush();
      expect(f.calls).not.toContain("credential_gate");
      f.reads[1 - first]!.resolve(first ? {} : f.settings);
      await expect(f.running).rejects.toBe(f.stop);
      expect(f.calls).toEqual(["session", "capabilities", "credential_gate"]);
    } finally {
      await f.cleanup();
    }
  });
}

for (const failed of [0, 1]) {
  test(`full claim propagates read ${failed} failure with no late credential continuation`, async () => {
    const f = actualClaimFixture();
    const failure = new Error("fresh read failed");
    try {
      f.claimRead.resolve({ action: "claimed", turn: f.turn });
      await flush();
      expect(f.calls).toEqual(["session", "capabilities"]);
      f.reads[failed]!.reject(failure);
      await expect(f.running).rejects.toBe(failure);
      f.reads[1 - failed]!.resolve(failed ? {} : f.settings);
      await flush();
      expect(f.calls).not.toContain("credential_gate");
    } finally {
      await f.cleanup();
    }
  });
}
