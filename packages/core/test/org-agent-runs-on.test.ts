// Runs on for organization (Console) agent chats, pure parts: how a version's
// `runsOn` becomes the create's placement fields, how a request's own
// placement is layered on top (and recorded as an override), and the
// refusals (Personal machines, machines or environments outside their reach,
// unknown names). Reach itself is the database's (see
// packages/db/test/organization-compute-reach-postgres.test.ts).
import { describe, expect, test } from "bun:test";
import { OrgAgentRunsOn } from "@opengeni/contracts";
import type { OrgComputeEntry } from "@opengeni/db";

import {
  applyOrgAgentRunsOn,
  assertOrgAgentChatMachine,
  OrgAgentRunsOnError,
  type OrgAgentRunsOnDeps,
} from "../src/domain/org-agent-runs-on";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const BUILD_BOX: OrgComputeEntry = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sandboxId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Build box",
  reach: {
    homeWorkspaceId: WORKSPACE,
    allowedWorkspaceIds: [],
    allowPersonalWorkspaces: false,
    allowManagedWorkspaces: true,
  },
};
const OTHER_BOX: OrgComputeEntry = {
  ...BUILD_BOX,
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  sandboxId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  name: "Other box",
};
const PYTHON: OrgComputeEntry = {
  ...BUILD_BOX,
  id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  sandboxId: null,
  name: "Python 3.13",
};
const PERSONAL_SANDBOX = "ffffffff-ffff-4fff-8fff-ffffffffffff";

function deps(
  options: {
    reachable?: string[];
    backend?: "daytona" | "selfhosted" | "none" | "modal";
  } = {},
): OrgAgentRunsOnDeps {
  const reachable = new Set(options.reachable ?? [BUILD_BOX.id, OTHER_BOX.id, PYTHON.id]);
  return {
    db: {} as never,
    settings: { sandboxBackend: (options.backend ?? "daytona") as never },
    listOrganizationCompute: async (kind) =>
      kind === "machine" ? [BUILD_BOX, OTHER_BOX] : [PYTHON],
    machineWorksHere: async (id) => reachable.has(id),
    rigWorksHere: async (id) => reachable.has(id),
    sandboxScope: async (id) => (id === PERSONAL_SANDBOX ? "user" : "organization"),
  };
}

const grant = { accountId: ACCOUNT, subjectId: "external_user:kontali:42" };

async function place(
  runsOn: OrgAgentRunsOn | undefined,
  payload: Record<string, unknown> = {},
  options: Parameters<typeof deps>[0] & {
    metadata?: Record<string, unknown>;
    target?: { machineId?: string; environmentId?: string };
  } = {},
) {
  return await applyOrgAgentRunsOn({
    deps: deps(options),
    grant: { ...grant, ...(options.metadata ? { metadata: options.metadata } : {}) } as never,
    workspaceId: WORKSPACE,
    payload: { message: "hi", ...payload },
    runsOn,
    ...(options.target ? { target: options.target } : {}),
  });
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OrgAgentRunsOnError);
    return (error as OrgAgentRunsOnError).code;
  }
  throw new Error("expected a refusal");
}

describe("Runs on at create", () => {
  test("omitted keeps today's placement: the body is untouched", async () => {
    const placed = await place(undefined, { rigId: PYTHON.id });
    expect(placed.payload).toEqual({ message: "hi", rigId: PYTHON.id });
    expect(placed.overrides).toEqual({});
  });

  test("no computer: sandboxBackend none and no environment", async () => {
    const placed = await place({ kind: "none" });
    expect(placed.payload).toEqual({ message: "hi", sandboxBackend: "none", rigId: null });
    expect(placed.overrides).toEqual({});
  });

  test("cloud sandbox: the deployment's backend, with the environment by name", async () => {
    const placed = await place({ kind: "sandbox", environment: "python 3.13" });
    expect(placed.payload).toEqual({ message: "hi", sandboxBackend: "daytona", rigId: PYTHON.id });
  });

  test("cloud sandbox is refused where the deployment has none", async () => {
    expect(await refusal(place({ kind: "sandbox" }, {}, { backend: "selfhosted" }))).toBe(
      "runs_on_unavailable",
    );
  });

  test("organization machine: its sandbox is the target", async () => {
    const placed = await place({ kind: "machine", machine: "Build box" });
    expect(placed.payload).toEqual({
      message: "hi",
      targetSandboxId: BUILD_BOX.sandboxId,
      rigId: null,
    });
  });

  test("a machine or environment outside its reach is refused", async () => {
    expect(
      await refusal(place({ kind: "machine", machine: BUILD_BOX.id }, {}, { reachable: [] })),
    ).toBe("runs_on_unavailable");
    expect(
      await refusal(place({ kind: "sandbox", environment: PYTHON.id }, {}, { reachable: [] })),
    ).toBe("runs_on_unavailable");
  });

  test("unknown names are refused", async () => {
    expect(await refusal(place({ kind: "machine", machine: "Nope" }))).toBe("machine_not_found");
    expect(await refusal(place({ kind: "sandbox", environment: "Nope" }))).toBe(
      "environment_not_found",
    );
  });

  test("the request has the final say within reach, recorded as an override", async () => {
    const placed = await place(
      { kind: "machine", machine: "Build box" },
      { targetSandboxId: OTHER_BOX.sandboxId },
    );
    expect(placed.payload).toEqual({ message: "hi", targetSandboxId: OTHER_BOX.sandboxId });
    expect(placed.overrides).toEqual({
      runsOn: {
        agent: { kind: "machine", machine: "Build box" },
        chat: { targetSandboxId: OTHER_BOX.sandboxId },
      },
    });
    // The agent's own machine is not required to be reachable when the chat picks another.
    const elsewhere = await place(
      { kind: "machine", machine: "Build box" },
      { targetSandboxId: OTHER_BOX.sandboxId },
      { reachable: [OTHER_BOX.id] },
    );
    expect(elsewhere.payload["targetSandboxId"]).toBe(OTHER_BOX.sandboxId);
  });

  test("a request backend replaces the agent's; the environment stays for cloud sandboxes", async () => {
    const placed = await place(
      { kind: "sandbox", environment: PYTHON.id },
      { sandboxBackend: "modal" },
    );
    expect(placed.payload).toEqual({ message: "hi", sandboxBackend: "modal", rigId: PYTHON.id });
    expect(Object.keys(placed.overrides)).toEqual(["runsOn"]);
    const none = await place(
      { kind: "sandbox", environment: PYTHON.id },
      { sandboxBackend: "none" },
    );
    expect(none.payload).toEqual({ message: "hi", sandboxBackend: "none" });
  });

  test("asking for the agent's own placement is not an override", async () => {
    const placed = await place({ kind: "none" }, { sandboxBackend: "none" });
    expect(placed.overrides).toEqual({});
  });

  test("a Personal (Only me) machine is refused, with or without Runs on", async () => {
    expect(
      await refusal(
        place({ kind: "machine", machine: "Build box" }, { targetSandboxId: PERSONAL_SANDBOX }),
      ),
    ).toBe("personal_machine_not_allowed");
    expect(await refusal(place(undefined, { targetSandboxId: PERSONAL_SANDBOX }))).toBe(
      "personal_machine_not_allowed",
    );
  });

  test("a worker started from a chat shares its parent's computer", async () => {
    const placed = await place(
      { kind: "machine", machine: "Build box" },
      {},
      { metadata: { sessionId: "99999999-9999-4999-8999-999999999999" } },
    );
    expect(placed.payload).toEqual({ message: "hi" });
    expect(placed.overrides).toEqual({});
  });

  test("the id saved with the version wins over the written name", async () => {
    // "Build box" was renamed to "Other box"'s name, or a second "Build box"
    // appeared: the saved id still picks the machine the version was saved with.
    const placed = await place(
      { kind: "machine", machine: "Build box" },
      {},
      { target: { machineId: OTHER_BOX.id } },
    );
    expect(placed.payload["targetSandboxId"]).toBe(OTHER_BOX.sandboxId);
    const rig = await place(
      { kind: "sandbox", environment: "Old name" },
      {},
      { target: { environmentId: PYTHON.id } },
    );
    expect(rig.payload["rigId"]).toBe(PYTHON.id);
  });

  test("a saved id that was removed falls back to the written name", async () => {
    const gone = "12121212-1212-4212-8212-121212121212";
    const placed = await place(
      { kind: "machine", machine: "Build box" },
      {},
      { target: { machineId: gone } },
    );
    expect(placed.payload["targetSandboxId"]).toBe(BUILD_BOX.sandboxId);
    expect(
      await refusal(
        place({ kind: "machine", machine: "Gone box" }, {}, { target: { machineId: gone } }),
      ),
    ).toBe("machine_not_found");
    expect(
      await refusal(
        place(
          { kind: "sandbox", environment: "Gone environment" },
          {},
          { target: { environmentId: gone } },
        ),
      ),
    ).toBe("environment_not_found");
  });
});

describe("where an organization agent chat finally lands", () => {
  const access = { accountId: ACCOUNT, workspaceId: WORKSPACE, subjectId: "user:1" };
  const check = (sandbox: { scope: string | null } | null) =>
    assertOrgAgentChatMachine(
      { db: {} as never, readSandbox: async () => sandbox },
      access,
      BUILD_BOX.sandboxId!,
    );

  test("organization and workspace machines and cloud boxes pass", async () => {
    await check({ scope: "organization" });
    await check({ scope: "workspace" });
    // A cloud sandbox is not a Connected Machine and has no machine scope.
    await check({ scope: null });
  });

  test("a Personal machine is refused", async () => {
    expect(await refusal(check({ scope: "user" }))).toBe("personal_machine_not_allowed");
  });

  test("a target the caller can't read is refused", async () => {
    expect(await refusal(check(null))).toBe("runs_on_unavailable");
  });
});

describe("Runs on shape", () => {
  test("machine needs a machine; environment is only for a cloud sandbox", () => {
    expect(OrgAgentRunsOn.safeParse({ kind: "machine" }).success).toBe(false);
    expect(OrgAgentRunsOn.safeParse({ kind: "none", machine: "x" }).success).toBe(false);
    expect(
      OrgAgentRunsOn.safeParse({ kind: "machine", environment: "x", machine: "y" }).success,
    ).toBe(false);
    expect(OrgAgentRunsOn.safeParse({ kind: "sandbox", environment: "x" }).success).toBe(true);
    expect(OrgAgentRunsOn.safeParse({ kind: "cloud" }).success).toBe(false);
  });
});
