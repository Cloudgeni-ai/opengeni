import { describe, expect, test } from "bun:test";
import {
  CreatePreferenceRegistryProposalRequest as ContractCreateProposal,
  PreferenceRegistryConflictStrategy as ContractConflictStrategy,
  PreferenceRegistryRecord as ContractRecord,
  PreferenceRegistryScope as ContractScope,
  PreferenceRegistryStatus as ContractStatus,
  PreferenceRegistryTrust as ContractTrust,
} from "@opengeni/contracts";
import type { z } from "zod";
import { OpenGeniClient } from "../src/index";
import { OpenGeniBrowserClient } from "../src/browser";
import type {
  CreatePreferenceRegistryProposalRequest,
  PreferenceRegistryConflictStrategy,
  PreferenceRegistryRecord,
  PreferenceRegistryScope,
  PreferenceRegistryStatus,
  PreferenceRegistryTrust,
} from "../src/preference-registry";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const PREFERENCE_ID = "00000000-0000-4000-8000-000000000002";
const REVISION_ID = "00000000-0000-4000-8000-000000000003";
const REPLACEMENT_ID = "00000000-0000-4000-8000-000000000004";

describe("preference registry SDK", () => {
  test("keeps registry literals and request/response directions aligned with contracts", () => {
    const scopes: readonly PreferenceRegistryScope[] = ContractScope.options;
    const statuses: readonly PreferenceRegistryStatus[] = ContractStatus.options;
    const trust: readonly PreferenceRegistryTrust[] = ContractTrust.options;
    const conflicts: readonly PreferenceRegistryConflictStrategy[] =
      ContractConflictStrategy.options;
    expect(scopes).toEqual(ContractScope.options);
    expect(statuses).toEqual(ContractStatus.options);
    expect(trust).toEqual(ContractTrust.options);
    expect(conflicts).toEqual(ContractConflictStrategy.options);

    const acceptRecord = (value: z.infer<typeof ContractRecord>): PreferenceRegistryRecord => value;
    const acceptProposal = (
      value: CreatePreferenceRegistryProposalRequest,
    ): z.input<typeof ContractCreateProposal> => value;
    expect(typeof acceptRecord).toBe("function");
    expect(typeof acceptProposal).toBe("function");
  });

  const registryWireContract = async (Client: typeof OpenGeniBrowserClient) => {
    const requests: Request[] = [];
    const client = new Client({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return new Response("{}", { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });

    await client.listPreferenceRegistry(WORKSPACE_ID, {
      scope: "workspace",
      status: "active",
      limit: 25,
    });
    await client.getPreferenceRegistry(WORKSPACE_ID, PREFERENCE_ID);
    await client.createPreferenceRegistryProposal(WORKSPACE_ID, {
      stableKey: "response-style",
      scope: "user",
      title: "Response style",
      description: "Prefer concise responses.",
      content: "Use compact answers unless detail is needed.",
      provenanceSource: "human",
    });
    await client.activatePreferenceRegistryRevision(WORKSPACE_ID, PREFERENCE_ID, {
      revisionId: REVISION_ID,
      expectedCurrentRevisionId: null,
      expectedScopeVersion: 1,
      reason: "Reviewed by the owner",
    });
    await client.correctPreferenceRegistry(WORKSPACE_ID, PREFERENCE_ID, {
      expectedCurrentRevisionId: REVISION_ID,
      expectedScopeVersion: 1,
      title: "Response style",
      description: "Prefer compact responses.",
      content: "Use compact answers unless the user asks for detail.",
      reason: "Clarify the preference",
    });
    await client.changePreferenceRegistryScope(WORKSPACE_ID, PREFERENCE_ID, {
      scope: "workspace",
      expectedScopeVersion: 1,
      reason: "Adopt for the workspace",
    });
    await client.deactivatePreferenceRegistry(WORKSPACE_ID, PREFERENCE_ID, {
      expectedCurrentRevisionId: REVISION_ID,
      expectedScopeVersion: 1,
      reason: "Temporarily disable",
    });
    await client.supersedePreferenceRegistry(WORKSPACE_ID, PREFERENCE_ID, {
      replacementPreferenceId: REPLACEMENT_ID,
      expectedCurrentRevisionId: REVISION_ID,
      expectedScopeVersion: 1,
      reason: "Use the replacement",
    });
    await client.rejectPreferenceRegistryProposal(WORKSPACE_ID, PREFERENCE_ID, {
      revisionId: REVISION_ID,
      expectedScopeVersion: 1,
      reason: "Not authoritative",
    });
    await client.getPreferenceRegistrySummary(WORKSPACE_ID);
    await client.getPreferenceRegistryFullContent(
      WORKSPACE_ID,
      `preference://${PREFERENCE_ID}/revisions/${REVISION_ID}?sha256=${"a".repeat(64)}`,
    );

    expect(requests.map((request) => [request.method, request.url])).toEqual([
      [
        "GET",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/preferences?scope=workspace&status=active&limit=25`,
      ],
      [
        "GET",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/preferences/${PREFERENCE_ID}`,
      ],
      ["POST", `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/preferences/proposals`],
      [
        "POST",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/preferences/${PREFERENCE_ID}/activate`,
      ],
      [
        "POST",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/preferences/${PREFERENCE_ID}/correct`,
      ],
      [
        "POST",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/preferences/${PREFERENCE_ID}/scope`,
      ],
      [
        "POST",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/preferences/${PREFERENCE_ID}/deactivate`,
      ],
      [
        "POST",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/preferences/${PREFERENCE_ID}/supersede`,
      ],
      [
        "POST",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/preferences/${PREFERENCE_ID}/reject`,
      ],
      ["GET", `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/preferences/summary`],
      ["POST", `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/preferences/full-content`],
    ]);
    expect(await requests[2]!.json()).toMatchObject({
      stableKey: "response-style",
      scope: "user",
      provenanceSource: "human",
    });
    expect(await requests[3]!.json()).toEqual({
      revisionId: REVISION_ID,
      expectedCurrentRevisionId: null,
      expectedScopeVersion: 1,
      reason: "Reviewed by the owner",
    });
    expect(await requests[4]!.json()).toEqual({
      expectedCurrentRevisionId: REVISION_ID,
      expectedScopeVersion: 1,
      title: "Response style",
      description: "Prefer compact responses.",
      content: "Use compact answers unless the user asks for detail.",
      reason: "Clarify the preference",
    });
    expect(await requests[6]!.json()).toEqual({
      expectedCurrentRevisionId: REVISION_ID,
      expectedScopeVersion: 1,
      reason: "Temporarily disable",
    });
    expect(await requests[7]!.json()).toEqual({
      replacementPreferenceId: REPLACEMENT_ID,
      expectedCurrentRevisionId: REVISION_ID,
      expectedScopeVersion: 1,
      reason: "Use the replacement",
    });
    expect(await requests[8]!.json()).toEqual({
      revisionId: REVISION_ID,
      expectedScopeVersion: 1,
      reason: "Not authoritative",
    });
    expect(await requests[10]!.json()).toEqual({
      retrievalHandle: `preference://${PREFERENCE_ID}/revisions/${REVISION_ID}?sha256=${"a".repeat(64)}`,
    });
  };
  test.each([OpenGeniClient, OpenGeniBrowserClient])(
    "%p preserves the complete registry wire contract",
    registryWireContract,
  );

  test.each(["network", 403, 409] as const)(
    "browser registry activation propagates %p without replaying or changing its fences",
    async (failure) => {
      const requests: Request[] = [];
      const client = new OpenGeniBrowserClient({
        baseUrl: "https://api.example.test",
        fetch: (async (input, init) => {
          requests.push(new Request(input, init));
          if (failure === "network") throw new TypeError("connection lost after send");
          return Response.json({ error: "refused" }, { status: failure });
        }) as typeof fetch,
      });
      const request = {
        revisionId: REVISION_ID,
        expectedCurrentRevisionId: null,
        expectedScopeVersion: 1,
        reason: "Reviewed by the owner",
      };
      await expect(
        client.activatePreferenceRegistryRevision(WORKSPACE_ID, PREFERENCE_ID, request),
      ).rejects.toMatchObject(
        failure === "network"
          ? { code: "network_error", outcomeUnknown: true }
          : { status: failure },
      );
      expect(requests).toHaveLength(1);
      expect(await requests[0]!.json()).toEqual(request);
      expect(requests[0]!.headers.has("authorization")).toBe(false);
    },
  );
});
