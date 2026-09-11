import { describe, expect, test } from "bun:test";
import {
  WorkspaceStateExportResponse as ContractWorkspaceStateExportResponse,
  WorkspaceStateResponse as ContractWorkspaceStateResponse,
} from "@opengeni/contracts";
import { OpenGeniClient } from "../src/client";
import type { WorkspaceStateExportResponse, WorkspaceStateResponse } from "../src/workspace-state";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

describe("workspace state SDK", () => {
  test("maps the read-only inventory to its stable GET route", async () => {
    const requests: Request[] = [];
    const response = {
      workspaceId: WORKSPACE_ID,
      generatedAt: "2026-07-30T12:00:00.000Z",
      truth: {
        current: { source: "read_time_projection", capturedAt: "2026-07-30T12:00:00.000Z" },
        attemptGovernance: { status: "not_requested" },
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
      preferences: {
        authority: "preference_registry_preferences",
        activeDescriptorCount: 0,
        activeDescriptorHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        scopeCounts: { organization: 0, workspace: 0, user: 0 },
        truncated: false,
      },
      knowledge: {
        availability: "available",
        coverage: "complete",
        authority: "knowledge_entries",
        sampleLimit: 50,
        entries: [],
      },
    } satisfies WorkspaceStateResponse;
    const exportResponse = {
      kind: "opengeni.workspace_state.sanitized_export",
      schemaVersion: 1,
      generatedAt: response.generatedAt,
      stateSha256: "f".repeat(64),
      omissions: [
        "hidden_platform_prompts",
        "policy_bodies",
        "preference_content",
        "document_content_and_private_metadata",
        "memory_content_and_provenance",
        "secret_values_and_credentials",
        "session_messages_and_tool_outputs",
      ],
      state: response,
    } satisfies WorkspaceStateExportResponse;
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json(request.url.includes("/export") ? exportResponse : response);
      }) as typeof fetch,
    });

    expect(await client.getWorkspaceState(WORKSPACE_ID)).toEqual(response);
    expect(
      await client.getWorkspaceState(WORKSPACE_ID, {
        attemptId: "00000000-0000-4000-8000-000000000099",
      }),
    ).toEqual(response);
    expect(await client.exportWorkspaceState(WORKSPACE_ID)).toEqual(exportResponse);
    expect(
      await client.exportWorkspaceState(WORKSPACE_ID, {
        attemptId: "00000000-0000-4000-8000-000000000099",
      }),
    ).toEqual(exportResponse);
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["GET", `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/workspace-state`],
      [
        "GET",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/workspace-state?attemptId=00000000-0000-4000-8000-000000000099`,
      ],
      ["GET", `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/workspace-state/export`],
      [
        "GET",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/workspace-state/export?attemptId=00000000-0000-4000-8000-000000000099`,
      ],
    ]);
    expect(ContractWorkspaceStateResponse.safeParse(response).success).toBe(true);
    expect(ContractWorkspaceStateExportResponse.safeParse(exportResponse).success).toBe(true);

    const serverToClient = (
      value: typeof ContractWorkspaceStateResponse._output,
    ): WorkspaceStateResponse => value;
    expect(serverToClient(ContractWorkspaceStateResponse.parse(response))).toEqual(response);
  });
});
