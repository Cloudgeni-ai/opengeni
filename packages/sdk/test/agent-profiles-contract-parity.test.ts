import { expect, test } from "bun:test";
import type {
  AgentAvatar as ContractAgentAvatar,
  AgentProfile as ContractAgentProfile,
  AgentProfileVersion as ContractAgentProfileVersion,
  ApplySessionAgentProfileRequest as ContractApplyRequest,
  CreateAgentProfileRequest as ContractCreateRequest,
  SessionAgentProfile as ContractSessionAgentProfile,
  UpdateAgentProfileRequest as ContractUpdateRequest,
  UpdateSessionAgentIdentityRequest as ContractIdentityRequest,
} from "@opengeni/contracts";
import type {
  AgentAvatar,
  AgentProfile,
  AgentProfileVersion,
  ApplySessionAgentProfileRequest,
  CreateAgentProfileRequest,
  SessionAgentProfile,
  UpdateAgentProfileRequest,
  UpdateSessionAgentIdentityRequest,
} from "../src/types";
import { OpenGeniClient } from "../src/client";
import { OpenGeniAgentProfilesClient } from "../src/agent-profiles";

test("agent profile SDK mirrors match the contracts", () => {
  const checks = [
    (value: ContractAgentAvatar): AgentAvatar => value,
    (value: AgentAvatar): ContractAgentAvatar => value,
    (value: ContractAgentProfile): AgentProfile => value,
    (value: ContractAgentProfileVersion): AgentProfileVersion => value,
    (value: ContractSessionAgentProfile): SessionAgentProfile => value,
    (value: SessionAgentProfile): ContractSessionAgentProfile => value,
    (value: ApplySessionAgentProfileRequest): ContractApplyRequest => value,
    (value: UpdateSessionAgentIdentityRequest): ContractIdentityRequest => value,
    (value: UpdateAgentProfileRequest): ContractUpdateRequest => value,
    // `config` has a server-side default, so only the SDK -> wire direction holds.
    (value: CreateAgentProfileRequest): Omit<ContractCreateRequest, "config"> => value,
  ];
  expect(checks.every((check) => typeof check === "function")).toBe(true);
});

test("agent profile client methods call the documented routes", async () => {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const client = new OpenGeniAgentProfilesClient(
    new OpenGeniClient({
      baseUrl: "https://example.test",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          method: init?.method ?? "GET",
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json({ profiles: [] });
      }) as typeof fetch,
    }),
  );
  await client.listAgentProfiles("w", { status: "all" });
  await client.createAgentProfile("w", {
    name: "Annie",
    avatar: { kind: "emoji", emoji: "🦉", hue: 235 },
  });
  await client.archiveAgentProfile("w", "p");
  await client.applySessionAgentProfile("w", "s", { agentProfileId: "p", expectedVersion: 3 });
  await client.updateSessionAgentIdentity("w", "s", { identity: null });
  expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
    "GET /v1/workspaces/w/agent-profiles",
    "POST /v1/workspaces/w/agent-profiles",
    "POST /v1/workspaces/w/agent-profiles/p/archive",
    "PUT /v1/workspaces/w/sessions/s/agent-profile",
    "PUT /v1/workspaces/w/sessions/s/agent-identity",
  ]);
  expect(new URL(calls[0]!.url).searchParams.get("status")).toBe("all");
  expect(calls[3]!.body).toEqual({ agentProfileId: "p", expectedVersion: 3 });
});
