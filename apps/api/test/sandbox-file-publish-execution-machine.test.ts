import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import * as core from "@opengeni/core";
import * as db from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

import * as fleetContext from "../src/sandbox/agent-fleet-context";
import { codemodeCallExecutionMachine } from "../src/sandbox-file-artifacts";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const OPERATION = "44444444-4444-4444-8444-444444444444";
const ACTIVE = "55555555-5555-4555-8555-555555555555";
const OTHER_MACHINE = "66666666-6666-4666-8666-666666666666";

const grant = (sessionId = SESSION) =>
  ({
    accountId: ACCOUNT,
    workspaceId: WORKSPACE,
    subjectId: "sandbox:77777777-7777-4777-8777-777777777777",
    principalKind: "agent_attempt",
    permissions: [],
    metadata: {
      sessionId,
      turnId: "88888888-8888-4888-8888-888888888888",
      attemptId: "77777777-7777-4777-8777-777777777777",
      executionGeneration: 1,
    },
  }) as unknown as AccessGrant;

const deps = { db: {} } as unknown as core.ApiRouteDeps;
const machine = {
  sandbox: { id: OTHER_MACHINE, workspaceId: WORKSPACE, enrollmentId: "enrollment" },
  enrollment: { connectionInstanceId: "runner", workspaceRoot: "/home/user/work" },
} as unknown as core.RunOnMachine;

function stubs(options: {
  recorded: string | null;
  resolution?: Awaited<ReturnType<typeof core.resolveRunOnMachine>>;
}) {
  const lookup = spyOn(db, "getCodemodeCallExecutionSandboxId").mockResolvedValue(options.recorded);
  spyOn(db, "readActiveSandbox").mockResolvedValue({
    activeSandboxId: ACTIVE,
  } as Awaited<ReturnType<typeof db.readActiveSandbox>>);
  const context = { accountId: ACCOUNT, workspaceId: WORKSPACE, sessionId: SESSION };
  spyOn(fleetContext, "sessionFleetContextForCaller").mockResolvedValue(
    context as Awaited<ReturnType<typeof fleetContext.sessionFleetContextForCaller>>,
  );
  const resolve = spyOn(core, "resolveRunOnMachine").mockResolvedValue(
    options.resolution ?? { ok: true, machine },
  );
  return { lookup, resolve, context };
}

afterEach(() => {
  mock.restore();
});

describe("the machine a Codemode call's code runs on", () => {
  test("model calls and calls from another session's token use the active sandbox", async () => {
    const { lookup } = stubs({ recorded: OTHER_MACHINE });
    expect(
      await codemodeCallExecutionMachine(deps, {
        grant: grant(),
        sessionId: SESSION,
        codemodeOperationId: null,
      }),
    ).toBeNull();
    expect(
      await codemodeCallExecutionMachine(deps, {
        grant: grant("99999999-9999-4999-8999-999999999999"),
        sessionId: SESSION,
        codemodeOperationId: OPERATION,
      }),
    ).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  test("code on the session's own sandbox keeps resolving paths there", async () => {
    for (const recorded of [null, ACTIVE]) {
      mock.restore();
      const { resolve } = stubs({ recorded });
      expect(
        await codemodeCallExecutionMachine(deps, {
          grant: grant(),
          sessionId: SESSION,
          codemodeOperationId: OPERATION,
        }),
      ).toBeNull();
      expect(resolve).not.toHaveBeenCalled();
    }
  });

  test("code a run_on exec runs elsewhere resolves on that machine after run_on's access check", async () => {
    const { lookup, resolve, context } = stubs({ recorded: OTHER_MACHINE });
    expect(
      await codemodeCallExecutionMachine(deps, {
        grant: grant(),
        sessionId: SESSION,
        codemodeOperationId: OPERATION,
      }),
    ).toBe(machine);
    expect(lookup).toHaveBeenCalledWith(deps.db, {
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      sessionId: SESSION,
      operationId: OPERATION,
    });
    expect(resolve).toHaveBeenCalledWith(deps, context, OTHER_MACHINE);
  });

  test("an unreachable machine refuses with run_on's reason instead of reading the active sandbox", async () => {
    stubs({
      recorded: OTHER_MACHINE,
      resolution: { ok: false, reason: "sandbox is offline; reconnect it" },
    });
    const refused = await codemodeCallExecutionMachine(deps, {
      grant: grant(),
      sessionId: SESSION,
      codemodeOperationId: OPERATION,
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HTTPException);
    expect((refused as HTTPException).status).toBe(409);
    expect((refused as HTTPException).message).toBe("sandbox is offline; reconnect it");
  });
});
