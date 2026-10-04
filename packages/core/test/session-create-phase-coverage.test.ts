import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import { measureSessionStartPhase } from "../src/domain/session-start-timing";

const source = readFileSync(new URL("../src/domain/sessions.ts", import.meta.url), "utf8");
const parsed = parseSync("sessions.ts", source);
expect(parsed.errors).toEqual([]);

const addedPhases = {
  workspace_read: "requireWorkspace",
  model_catalog_initial: "resolveWorkspaceModelBoundarySettings",
  default_model: "resolveDefaultSessionModel",
  model_catalog_effective: "resolveWorkspaceModelBoundarySettings",
  capability_settings: "settingsWithEnabledCapabilityMcpServers",
  initiator_freeze: "withWorkspaceSessionActivityRls",
  allowance: "requireLimit",
  shell_insert: ["createSessionWithIdempotencyKeyResult", "createSession"],
};

function phaseCalls() {
  const calls: any[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (
      node.type === "CallExpression" &&
      node.callee?.name === "measureSessionStartPhase" &&
      Object.hasOwn(addedPhases, node.arguments[1]?.value)
    )
      calls.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(parsed.program);
  return calls;
}

const calls = phaseCalls();

function exactCall(node: any, values: object) {
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
    `const result = ${source.slice(node.start, node.end)};`,
  );
  return new Function(
    "values",
    `
    const { measureSessionStartPhase, input, db, unresolvedDeps, grant, workspaceId,
      payload, retainedKeyedShellModel, settings, workspace, deps, effectiveModelId,
      parentSession, inheritedModel, inheritedPersonalConnectionDelegations,
      creationInitiator, frozenCreationInitiator, model, sessionMetadata,
      frozenCreatedByContext, beforeCreateCommit, requireWorkspace,
      resolveWorkspaceModelBoundarySettings, resolveDefaultSessionModel,
      settingsWithEnabledCapabilityMcpServers, withWorkspaceSessionActivityRls,
      frozenInitiatorForCommandActor, initiatingHumanForAllowance, requireLimit,
      createSessionWithIdempotencyKeyResult, createSession } = values;
    ${code}
    return result;
  `,
  )(values) as Promise<unknown>;
}

test("new core boundaries wrap one existing helper without new awaits or concurrent work", () => {
  expect(calls).toHaveLength(9);
  for (const [phase, helper] of Object.entries(addedPhases)) {
    const sites = calls.filter((c) => c.arguments[1].value === phase);
    const expected = Array.isArray(helper) ? helper : [helper];
    expect(sites.map((c) => c.arguments[2].body.callee.name)).toEqual(expected);
    for (const site of sites) {
      expect(site.arguments[2].type).toBe("ArrowFunctionExpression");
      expect(site.arguments[2].async).toBe(false);
      expect(site.arguments[2].body.type).toBe("CallExpression");
      expect(site.arguments[0].type).toBe("MemberExpression");
      expect(["startupObservability", "observability"]).toContain(site.arguments[0].property.name);
    }
  }
});

for (const node of calls) {
  const phase = node.arguments[1].value;
  const helper = node.arguments[2].body.callee.name;
  test(`held exact production ${phase}/${helper} records only its existing dependency`, async () => {
    let resolve!: (value: unknown) => void;
    const held = new Promise<unknown>((yes) => {
      resolve = yes;
    });
    const names: string[] = [];
    const endings: unknown[] = [];
    const seen: unknown[][] = [];
    const observer = {
      startSpan: (name: string) => {
        names.push(name);
        return {
          traceId: "1".repeat(32),
          spanId: "2".repeat(16),
          end: (input: unknown) => {
            endings.push(input);
          },
        };
      },
    };
    const db = {};
    const grant = { accountId: "account", subjectId: "subject", subjectLabel: "label" };
    const settings = {};
    const unresolvedDeps = { db, settings, observability: observer };
    const input = {
      db,
      startupObservability: observer,
      requestedSessionId: "chosen-session",
      accountId: "account",
      workspaceId: "workspace",
      model: "model",
      metadata: {},
      resources: [],
      tools: [],
      firstPartyMcpTools: [],
    };
    const spy = (...args: unknown[]) => {
      seen.push(args);
      return held;
    };
    const values = {
      measureSessionStartPhase,
      input,
      db,
      grant,
      settings,
      unresolvedDeps,
      workspaceId: "workspace",
      payload: {},
      retainedKeyedShellModel: null,
      workspace: { settings: {} },
      deps: unresolvedDeps,
      effectiveModelId: "model",
      parentSession: null,
      inheritedModel: "model",
      inheritedPersonalConnectionDelegations: null,
      creationInitiator: { initiator: { kind: "subject", subjectId: "subject" } },
      frozenCreationInitiator: { human: "subject" },
      model: "model",
      sessionMetadata: { private: "metadata" },
      frozenCreatedByContext: null,
      beforeCreateCommit: undefined,
      initiatingHumanForAllowance: (v: any) => v.human,
      [helper]: spy,
    };
    const result = { private: "unchanged result" };
    let completed = false;
    const running = exactCall(node, values).then((value) => {
      completed = true;
      return value;
    });
    try {
      expect(seen).toHaveLength(1);
      expect(names).toEqual([`core.session_start.${phase}`]);
      expect(endings).toEqual([]);
      await Promise.resolve();
      expect(completed).toBe(false);
      if (phase === "workspace_read") expect(seen[0]).toEqual([db, "workspace"]);
      if (phase === "model_catalog_initial")
        expect(seen[0]).toEqual([unresolvedDeps, grant, "workspace", [undefined], null]);
      if (phase === "model_catalog_effective")
        expect(seen[0]).toEqual([unresolvedDeps, grant, "workspace", ["model"], null]);
      if (phase === "default_model")
        expect(seen[0]).toEqual([
          db,
          settings,
          {
            accountId: "account",
            workspaceId: "workspace",
            subjectId: "subject",
            workspaceSettings: {},
          },
        ]);
      if (phase === "capability_settings")
        expect(seen[0]).toEqual([db, "workspace", settings, { subjectId: "subject" }]);
      if (phase === "allowance")
        expect(seen[0]).toEqual([
          unresolvedDeps,
          {
            accountId: "account",
            workspaceId: "workspace",
            initiatingHumanSubjectId: "subject",
            action: "agent_run:create",
            quantity: 1,
            model: "model",
          },
        ]);
      if (phase === "initiator_freeze") {
        expect(seen[0]!.slice(0, 2)).toEqual([db, "workspace"]);
        const tx = {};
        let scopedArgs: unknown[] = [];
        const callbackNode = node.arguments[2].body.arguments[2];
        const callbackCode = new Bun.Transpiler({ loader: "ts" }).transformSync(
          `const callback = ${source.slice(callbackNode.start, callbackNode.end)};`,
        );
        const callback = new Function(
          "values",
          "frozenInitiatorForCommandActor",
          `const { workspaceId, creationInitiator, grant } = values; ${callbackCode} return callback;`,
        )(values, (...args: unknown[]) => {
          scopedArgs = args;
          return held;
        });
        expect(callback(tx)).toBe(held);
        expect(scopedArgs).toEqual([
          tx,
          "workspace",
          { type: "human", subjectId: "subject" },
          "label",
        ]);
      }
      if (phase === "shell_insert") {
        expect(seen[0]![0]).toBe(db);
        expect(seen[0]![1]).toMatchObject({
          requestedSessionId: "chosen-session",
          accountId: "account",
          workspaceId: "workspace",
          model: "model",
          metadata: values.sessionMetadata,
        });
      }
    } finally {
      resolve(result);
    }
    expect(await running).toBe(result);
    expect(endings).toEqual([{ attributes: { outcome: "completed" } }]);
    expect(JSON.stringify(endings)).not.toContain("private");
  });
}
