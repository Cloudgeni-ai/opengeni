import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  CreateConnectionRequest,
  CreateOrganizationApiKeyRequest,
  CreateSessionRequest,
  EnsureWorkspaceRequest,
  InstallApiIntegrationRequest,
  PreviewApiIntegrationRequest,
  UpdateSessionMcpApprovalPolicyRequest,
  UpdateWorkspaceSettingsRequest,
  CreateScheduledTaskRequest,
  CreateAutomationSourceRequest,
  CreateAutomationTriggerRequest,
  CreateWorkspaceWebhookRequest,
  PutWorkspaceCredentialProviderRequest,
} from "@opengeni/contracts";
import { AddExternalWorkspaceMemberRequest } from "@opengeni/contracts/external-identities";
import { SetWorkspaceAllowanceRequest } from "@opengeni/contracts/usage-allowances";
import * as sdkExamples from "../../../.agents/skills/opengeni-setup/references/setup-sdk";

const setupRoot = `${import.meta.dir}/../../../.agents/skills/opengeni-setup`;
const referencePath = `${setupRoot}/references/setup-api.md`;

function expectPreservedRequest(
  contract: { parse(input: unknown): unknown },
  request: Record<string, unknown>,
): void {
  // A successful Zod parse alone can silently strip an invented field. Every
  // documented field must survive parsing, including fields in nested objects.
  expect(contract.parse(request)).toMatchObject(request);
}

describe("developer setup skill", () => {
  test("all illustrative JSON request bodies match their exact public contracts", async () => {
    const markdown = await readFile(referencePath, "utf8");
    const examples = [...markdown.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
      JSON.parse(match[1]!),
    );
    expect(examples).toHaveLength(17);
    // The canonical product agent fragment opens the walkthrough.
    const canonical = examples.shift();
    expect(canonical).toEqual({
      agent: {
        identity: "You are Acme's product assistant. Be brief and factual.",
        capabilities: "none",
      },
      sandboxBackend: "none",
    });
    expectPreservedRequest(CreateSessionRequest, { initialMessage: "Hello", ...canonical });
    // Never permit arbitrary organization-key permissions. Tokens and remote
    // ids below are fake fixtures; the key request uses the actual public schema.
    expect(examples[0]).toEqual({
      name: "Product setup",
      access: "full",
      expiresAt: "<now + 30 days, ISO 8601>",
    });
    // The illustrative expiry is the only key-request placeholder. Substitute
    // a deterministic 30-day expiry before checking the unchanged strict schema.
    const keyRequest = {
      ...examples[0],
      expiresAt: new Date(Date.UTC(2026, 9, 3) + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
    expectPreservedRequest(CreateOrganizationApiKeyRequest, keyRequest);
    expect(() =>
      CreateOrganizationApiKeyRequest.parse({ ...keyRequest, permissions: ["workspace:admin"] }),
    ).toThrow();
    expectPreservedRequest(EnsureWorkspaceRequest, examples[1]);
    expectPreservedRequest(UpdateWorkspaceSettingsRequest, examples[2]);
    expectPreservedRequest(AddExternalWorkspaceMemberRequest, examples[3]);
    expectPreservedRequest(CreateConnectionRequest, examples[4]);
    expectPreservedRequest(PreviewApiIntegrationRequest, examples[5]);
    expectPreservedRequest(InstallApiIntegrationRequest, {
      ...examples[6],
      expectedContentSha256: "a".repeat(64),
    });
    // A fragment intentionally containing only MCP fields is a partial session.
    expectPreservedRequest(CreateSessionRequest, {
      initialMessage: "Safe tool check",
      ...examples[7],
    });
    expectPreservedRequest(UpdateSessionMcpApprovalPolicyRequest, examples[8]);
    expectPreservedRequest(CreateScheduledTaskRequest, examples[9]);
    expectPreservedRequest(CreateAutomationSourceRequest, {
      ...examples[10],
      webhookSecret: "fixture-secret-123",
    });
    expectPreservedRequest(CreateAutomationTriggerRequest, examples[11]);
    expectPreservedRequest(CreateWorkspaceWebhookRequest, examples[12]);
    expectPreservedRequest(PutWorkspaceCredentialProviderRequest, examples[13]);
    expectPreservedRequest(SetWorkspaceAllowanceRequest, examples[14]);
    expectPreservedRequest(CreateSessionRequest, examples[15]);
  });

  test("bootstrap distinguishes full access from the separate limited setup tier", async () => {
    const markdown = await readFile(referencePath, "utf8");
    expect(markdown).toContain("Create a **Full access** key with a 30-day expiry.");
    expect(markdown).toContain('{"name":"Product setup","access":"full","expiresAt"');
    expect(markdown).toContain("The limited `developer_setup` tier holds only");
    expect(markdown).toContain("(24-hour default expiry); it");
  });

  test("cleanup distinguishes disabled automations from deleted resources", async () => {
    const markdown = await readFile(referencePath, "utf8");
    const cleanup = (markdown.split("## Reruns, failures and cleanup")[1] ?? "").replace(
      /\s+/g,
      " ",
    );
    expect(cleanup).toContain(
      "Clean up **only disposable staging resources this run created**.",
    );
    expect(cleanup).toContain("Never delete reused resources.");
    expect(cleanup).toContain('status === "disabled"');
    expect(cleanup).toContain("`GET .../automations/triggers` / `listTriggers`");
    expect(cleanup).toContain("`GET .../automations/sources` / `listSources`");
    expect(cleanup).toContain("Disabled records remain listed.");
    expect(cleanup).toContain("For resources actually deleted, verify inventory absence");
    expect(cleanup).toContain("where an exact GET is supported, 404.");
    expect(cleanup).not.toContain("Verify inventory/GET absence after each removal.");
  });

  test("recipes use the canonical none agent without legacy branches or empty lists", async () => {
    const texts = await Promise.all(
      ["SKILL.md", "references/setup-api.md", "references/setup-sdk.ts"].map((path) =>
        readFile(`${setupRoot}/${path}`, "utf8"),
      ),
    );
    for (const text of texts) {
      expect(text).not.toMatch(/agentConfig\??\.enabled/);
      expect(text).not.toMatch(/admission-disabled|older\/admission/);
      expect(text).not.toMatch(/"?(?:bundledSkillIds|firstPartyMcpTools|tools)"?: ?\[\]/);
      expect(text).not.toMatch(/renderer"?: ?"opengeni"/);
    }
    expect(sdkExamples.productAgent).toEqual({
      identity: "You are Acme's product assistant. Be brief and factual.",
      capabilities: "none",
    });
  });

  test("the skill verifies a working chat before wiring product tools", async () => {
    const skill = await readFile(`${setupRoot}/SKILL.md`, "utf8");
    const chat = skill.indexOf("## 3. Embed a working chat agent and verify a real reply");
    const tools = skill.indexOf("## 4. Wire the product's own tools (default next step)");
    expect(chat).toBeGreaterThan(0);
    expect(tools).toBeGreaterThan(chat);
    expect(skill).toContain("createSessionProxyRoute");
    expect(skill).toContain("whether product tools are wired");
  });

  test("SDK examples remain callable and typechecked with the actual SDK", () => {
    expect(sdkExamples.productAgent.capabilities).toBe("none");
    for (const example of [
      sdkExamples.serverClient,
      sdkExamples.createSetupKey,
      sdkExamples.tenantWorkspaceId,
      sdkExamples.ensureProductWorkspace,
      sdkExamples.configureAgent,
      sdkExamples.admitProductUser,
      sdkExamples.createProductConnection,
      sdkExamples.installProductApi,
      sdkExamples.setMcpApproval,
      sdkExamples.configureSchedule,
      sdkExamples.configureEventSource,
      sdkExamples.configureWebhook,
      sdkExamples.configureCredentialProvider,
      sdkExamples.configureBudget,
      sdkExamples.createSmokeSession,
      sdkExamples.removeDisposableIntegration,
    ]) {
      expect(typeof example).toBe("function");
    }
  });
});
