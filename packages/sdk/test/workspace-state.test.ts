import { describe, expect, test } from "bun:test";
import { WorkspaceStateResponse as ContractWorkspaceStateResponse } from "@opengeni/contracts";
import { OpenGeniClient } from "../src/client";
import type { WorkspaceStateResponse } from "../src/workspace-state";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

describe("workspace state SDK", () => {
  test("maps the read-only inventory to its stable GET route", async () => {
    const requests: Request[] = [];
    const response = {
      workspaceId: WORKSPACE_ID,
      generatedAt: "2026-07-30T12:00:00.000Z",
      truth: {
        current: { source: "read_time_projection", capturedAt: "2026-07-30T12:00:00.000Z" },
        policySnapshot: {
          status: "not_captured",
          reason: "workspace_instruction_policy_snapshot_not_implemented",
        },
      },
      policy: {
        authority: "workspace_instruction_policy_heads",
        activeHeads: [],
        activeHeadsTruncated: false,
        latestRevision: null,
        legacyRuntime: {
          source: "deployment_default",
          workspaceOverrideConfigured: false,
        },
        runtimeComposition: { status: "not_implemented" },
      },
      knowledge: {
        availability: "unavailable",
        reason: "missing_permission",
        requiredPermission: "documents:search",
      },
    } satisfies WorkspaceStateResponse;
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json(response);
      }) as typeof fetch,
    });

    expect(await client.getWorkspaceState(WORKSPACE_ID)).toEqual(response);
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["GET", `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/workspace-state`],
    ]);
    expect(ContractWorkspaceStateResponse.safeParse(response).success).toBe(true);

    const serverToClient = (
      value: typeof ContractWorkspaceStateResponse._output,
    ): WorkspaceStateResponse => value;
    expect(serverToClient(ContractWorkspaceStateResponse.parse(response))).toEqual(response);
  });
});
