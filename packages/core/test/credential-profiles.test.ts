// The effective credential profile merge (docs/secrets.md, "Credential
// profiles"): nearer levels replace entries of the same name, ignoring case,
// and the nearest git helper setting wins. No database; references are fake.
import { describe, expect, test } from "bun:test";
import { effectiveCredentialProfile } from "../src/domain/credential-profiles";

const ref = (path: string) => ["{", "{secret:", path, "}}"].join("");
const SESSION = "00000000-0000-4000-8000-000000000001";

describe("effectiveCredentialProfile", () => {
  test("a nearer level replaces a name regardless of its case", () => {
    const effective = effectiveCredentialProfile([
      {
        sessionId: null,
        entries: [
          { name: "GH_TOKEN", reference: ref("workspace/GH_TOKEN/value") },
          { name: "AZURE_CLIENT_ID", reference: ref("workspace/AZURE_CLIENT_ID/value") },
        ],
        gitHelper: true,
      },
      {
        sessionId: SESSION,
        entries: [{ name: "gh_token", reference: ref("chat/GH_TOKEN/value") }],
        gitHelper: null,
      },
    ]);
    // One delivered variable per name, so Windows never sees two spellings.
    expect(effective.entries).toEqual([
      {
        name: "AZURE_CLIENT_ID",
        reference: ref("workspace/AZURE_CLIENT_ID/value"),
        source: { scope: "workspace", sessionId: null },
      },
      {
        name: "gh_token",
        reference: ref("chat/GH_TOKEN/value"),
        source: { scope: "session", sessionId: SESSION },
      },
    ]);
    expect(effective.gitHelper).toBe(true);
  });

  test("the nearest git helper setting wins and it is off by default", () => {
    expect(effectiveCredentialProfile([]).gitHelper).toBe(false);
    expect(
      effectiveCredentialProfile([
        { sessionId: null, entries: [], gitHelper: true },
        { sessionId: SESSION, entries: [], gitHelper: false },
      ]).gitHelper,
    ).toBe(false);
  });
});
