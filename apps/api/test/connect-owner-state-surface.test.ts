import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Glob } from "bun";

// ---------------------------------------------------------------------------
// Owner-bound OAuth/install state contract surface.
//
// An OAuth callback carries HMAC-signed state instead of a live principal and
// re-checks the starting person through `requireConnectOwnerAuthority`. A
// managed human's Personal workspace has no workspace_memberships row, so that
// re-check finds its owner only through the signed `personalOwnerVerified`
// claim. Fiken and the Slack bot once minted states without the claim, and the
// legacy X/Reddit callback re-checked with a bare membership lookup: all three
// failed only in Personal workspaces, after the provider consent screen.
//
// `ConnectOwner.personalOwnerVerified` is required, so a callback that drops
// the claim no longer compiles. This test covers what the compiler cannot:
//   1. every signed state in the API mints the owner fields through
//      `connectOwnerStateFields`, whose claim argument is required, or is on
//      the exact exempt list below. A new state is therefore either
//      owner-bound by construction or a deliberate, reviewed exemption; how
//      its payload is assembled (inline, spread or variable) does not matter;
//   2. no module that mints or reads owner-bound state re-checks its owner
//      through `getWorkspaceGrant` instead of `requireConnectOwnerAuthority`.
// ---------------------------------------------------------------------------

const apiRoot = join(import.meta.dir, "..");

/**
 * Signed states that carry no owner claim, each never re-checked by a
 * cookie-less owner callback. Counted exactly, so a new one is a deliberate
 * addition here rather than a silent exemption.
 */
const EXEMPT_STATES: Record<string, number> = {
  // Organization and workspace Codex device logins: the authenticated poll
  // compares its own live principal with the signed `actorSubjectId`.
  "src/routes/codex.ts": 2,
  // Organization and workspace SuperGrok device logins, polled the same way;
  // only the external-continuation lane reaches requireConnectOwnerAuthority,
  // which never reads the claim there.
  "src/routes/supergrok.ts": 2,
  // The provider-facing MCP OAuth reference: an id pointer to the full state,
  // which is itself minted through the helper and stored encrypted.
  "src/integrations/oauth-client.ts": 1,
  // Legacy GitHub App installation, discovery, selection and OAuth states:
  // workspace-scoped (no subject), and every callback re-checks the live
  // Better Auth session through requireGitHubManageGrant.
  "src/routes/github.ts": 8,
  // The MCP-started GitHub installation link, re-checked the same way.
  "src/mcp/server.ts": 1,
};

async function sources(): Promise<Array<{ path: string; text: string }>> {
  const files: Array<{ path: string; text: string }> = [];
  for await (const path of new Glob("src/**/*.ts").scan({ cwd: apiRoot })) {
    files.push({ path, text: await readFile(join(apiRoot, path), "utf8") });
  }
  return files;
}

/** The argument text of every `name(` call, with nested brackets balanced. */
function callArguments(text: string, name: string): string[] {
  const calls: string[] = [];
  const opener = new RegExp(`\\b${name}\\(`, "gu");
  for (const match of text.matchAll(opener)) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < text.length && depth > 0) {
      const char = text[index];
      if (char === "(" || char === "{" || char === "[") depth += 1;
      else if (char === ")" || char === "}" || char === "]") depth -= 1;
      index += 1;
    }
    calls.push(text.slice(start, index - 1));
  }
  return calls;
}

describe("owner-bound Connect state", () => {
  test("every owner-bound signed state mints the owner claim through the helper", async () => {
    const exempt: Record<string, number> = {};
    let ownerBound = 0;
    for (const { path, text } of await sources()) {
      for (const args of callArguments(text, "createSignedState")) {
        if (args.includes("connectOwnerStateFields(")) ownerBound += 1;
        else exempt[path] = (exempt[path] ?? 0) + 1;
      }
    }
    // Any path here that is not in EXEMPT_STATES (or a changed count) is a
    // signed state minted without the owner claim.
    expect(exempt).toEqual(EXEMPT_STATES);
    // Guards the scan itself: the known owner-bound starters are still found.
    expect(ownerBound).toBeGreaterThanOrEqual(9);
  });

  test("owner-bound callbacks re-check through requireConnectOwnerAuthority, never a bare membership lookup", async () => {
    const offenders: string[] = [];
    const ownerStateModules: string[] = [];
    for (const { path, text } of await sources()) {
      if (!/\b(connectOwnerStateFields|personalOwnerVerifiedInState)\(/u.test(text)) continue;
      ownerStateModules.push(path);
      if (/\bgetWorkspaceGrant\(/u.test(text)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
    expect(ownerStateModules).toEqual(
      expect.arrayContaining([
        "src/integrations/fiken.ts",
        "src/integrations/slack-install.ts",
        "src/integrations/social-oauth.ts",
        "src/routes/connections.ts",
      ]),
    );
  });
});
