import { describe, expect, test } from "bun:test";

import {
  apiOriginFor,
  buildWithOpengeniPrompt,
  codingAgentSetup,
  developerPluginGuides,
  isAppCreatedSession,
  MANAGED_API_ORIGIN,
  mcpServerGuides,
} from "./coding-agent-setup";
import { DEVELOPER_PLUGIN_INSTALL } from "./coding-agent-install";

const MCP = "https://app.opengeni.ai/v1/workspaces/ws-dev/mcp";

describe("coding-agent setup", () => {
  test("uses the API origin the browser talks to", () => {
    expect(apiOriginFor("", "https://app.opengeni.ai")).toBe("https://app.opengeni.ai");
    expect(apiOriginFor("http://homeserver:8000/", "http://homeserver:3000")).toBe(
      "http://homeserver:8000",
    );
    expect(apiOriginFor("/api", "https://example.test")).toBe("https://example.test/api");
  });

  test("building a product installs the skills-only developer plugin", () => {
    const guides = developerPluginGuides();
    expect(guides.map((guide) => guide.label)).toEqual([
      "Claude Code",
      "Codex",
      "Cursor",
      "VS Code",
      "Other",
    ]);
    const [claude, codex, cursor, vscode, other] = guides;
    expect(claude!.blocks[0]!.code).toBe(
      [
        "claude plugin marketplace add Cloudgeni-ai/opengeni",
        "claude plugin install opengeni-developer@opengeni-developer-plugins --scope user",
      ].join("\n"),
    );
    expect(codex!.blocks[0]!.code).toBe(
      [
        "codex plugin marketplace add Cloudgeni-ai/opengeni",
        "codex plugin add opengeni-developer@opengeni-developer-plugins",
      ].join("\n"),
    );
    expect(cursor!.blocks[0]!.code).toBe("https://github.com/Cloudgeni-ai/opengeni");
    expect(cursor!.note).toContain("From GitHub Repository");
    expect(vscode!.blocks[0]!.code).toBe(DEVELOPER_PLUGIN_INSTALL.skillsCopy.join("\n"));
    expect(other!.blocks[0]!.code).toContain(
      "sparse-checkout set .agents/skills/opengeni-setup .agents/skills/opengeni-client",
    );
    // Skills only: no MCP server and no key on the coding agent's side.
    for (const guide of guides)
      for (const block of guide.blocks) {
        expect(block.code).not.toContain("/mcp");
        expect(block.code).not.toContain("OPENGENI_API_KEY");
      }
  });

  test("handing work to Opengeni adds the workspace MCP server, keyless", () => {
    const guides = mcpServerGuides(
      codingAgentSetup({
        mcpOAuthEnabled: true,
        apiOrigin: MANAGED_API_ORIGIN,
        workspaceId: "ws-dev",
      }),
    );
    const [claude, codex, cursor, vscode, other] = guides;
    expect(claude!.blocks[0]!.code).toBe(
      `claude mcp add --scope user --transport http opengeni ${MCP}`,
    );
    expect(codex!.blocks[0]!.code).toBe(`codex mcp add opengeni --url ${MCP}`);
    expect(JSON.parse(cursor!.blocks[0]!.code)).toEqual({
      mcpServers: { opengeni: { url: MCP } },
    });
    expect(vscode!.blocks[0]!.code).toBe(
      `code --add-mcp '{"name":"opengeni","type":"http","url":"${MCP}"}'`,
    );
    expect(other!.blocks[0]!.code).toBe(MCP);
    expect(other!.note).toContain("any MCP client that supports remote servers and OAuth");
    for (const guide of guides)
      for (const block of guide.blocks) expect(block.code).not.toContain("OPENGENI_API_KEY");
  });
});

describe("the prompt for a coding agent", () => {
  test("names the developer plugin's skills and the real IDs, never the key", () => {
    expect(
      buildWithOpengeniPrompt({
        apiOrigin: MANAGED_API_ORIGIN,
        organizationId: "org-1",
        workspaceId: "ws-dev",
      }),
    ).toBe(
      "Use the opengeni-setup and opengeni-client skills to create a small local web app with an Opengeni agent chat. Use the existing workspace ws-dev in organization org-1. I'll paste the API key into .env as OPENGENI_API_KEY.",
    );
    expect(
      buildWithOpengeniPrompt({
        apiOrigin: "http://homeserver:8000",
        organizationId: "org-1",
        workspaceId: "ws-dev",
      }),
    ).toContain("in organization org-1 (OPENGENI_API_BASE_URL=http://homeserver:8000).");
  });

  test("an app's chats are told apart from people's", () => {
    expect(isAppCreatedSession({ createdBy: { subjectId: "api_key:key-1" } })).toBe(true);
    expect(isAppCreatedSession({ createdBy: { subjectId: "external_user:7f3c" } })).toBe(true);
    expect(isAppCreatedSession({ createdBy: { subjectId: "better-auth:ada" } })).toBe(false);
    expect(isAppCreatedSession({ createdBy: null })).toBe(false);
  });
});
