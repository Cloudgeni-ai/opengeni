import { describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";
import {
  clearPendingTeamsLink,
  readPendingTeamsLink,
  readPendingTeamsSetup,
  savePendingTeamsLink,
  savePendingTeamsSetup,
  teamsAuthReturnPath,
  teamsErrorText,
  teamsOwnAccountLinkedElsewhere,
  teamsFragmentToken,
  teamsMicrosoftFailureText,
  teamsMicrosoftReturn,
  teamsMicrosoftSignInPurpose,
  teamsRouteMissing,
} from "./teams-connect";
import { signupReturnPath } from "./signup-attribution";

describe("Teams setup and account-link continuation", () => {
  test("accepts a single bounded fragment proof, never duplicate or empty claims", () => {
    expect(teamsFragmentToken("#teams_setup=signed-proof", "teams_setup")).toBe("signed-proof");
    for (const hash of [
      "",
      "#teams_setup=",
      "#teams_setup=a&teams_setup=b",
      "#teams_setup=a+b",
      "#teams_setup=" + "a".repeat(16_385),
    ]) {
      expect(teamsFragmentToken(hash, "teams_setup")).toBeNull();
    }
    expect(teamsFragmentToken("#teams_link=abc", "teams_setup")).toBeNull();
  });

  test("preserves signed setup and link fragments through auth callbacks", () => {
    const setup = teamsAuthReturnPath({
      pathname: "/teams/connect",
      search: "",
      hash: "#teams_setup=signed-proof",
    });
    expect(setup).toBe("/teams/connect#teams_setup=signed-proof");
    expect(signupReturnPath(setup!, "google_signin")).toBe(
      "/teams/connect?auth_event=google_signin#teams_setup=signed-proof",
    );
    const link = teamsAuthReturnPath({
      pathname: "/workspaces/ws/plugins",
      search: "?provider=teams-bot",
      hash: "#teams_link=link-proof",
    });
    expect(link).toBe("/workspaces/ws/plugins?provider=teams-bot#teams_link=link-proof");
    expect(signupReturnPath(link!)).toBe(link!);
  });

  test("does not adopt arbitrary routes as Teams return destinations", () => {
    expect(
      teamsAuthReturnPath({ pathname: "/elsewhere", search: "", hash: "#teams_setup=x" }),
    ).toBeNull();
    expect(
      teamsAuthReturnPath({ pathname: "/workspaces/ws/plugins", search: "", hash: "#other=x" }),
    ).toBeNull();
    expect(
      teamsAuthReturnPath({
        pathname: "/workspaces/ws/capabilities",
        search: "",
        hash: "#teams_link=x",
      }),
    ).toBeNull();
  });
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

describe("Teams self-serve Microsoft sign-in return", () => {
  test("keeps the setup proof and workspace in this tab's storage, briefly", () => {
    const storage = memoryStorage();
    savePendingTeamsSetup({ setupToken: "signed-proof", workspaceId: "ws" }, storage, 1_000);
    expect([...storage.values.values()].join("")).not.toContain("teams_setup=");
    expect(readPendingTeamsSetup(storage, 2_000)).toEqual({
      setupToken: "signed-proof",
      workspaceId: "ws",
    });
    expect(readPendingTeamsSetup(storage, 1_000 + 15 * 60_000 + 1)).toBeNull();
    expect(readPendingTeamsSetup(storage, 999)).toBeNull();
    storage.setItem("opengeni.teams-setup", "{not json");
    expect(readPendingTeamsSetup(storage, 2_000)).toBeNull();
    storage.setItem(
      "opengeni.teams-setup",
      JSON.stringify({ setupToken: "", workspaceId: "ws", savedAt: 1_000 }),
    );
    expect(readPendingTeamsSetup(storage, 2_000)).toBeNull();
  });

  test("keeps the choice to replace the person's own link through the sign-in", () => {
    const storage = memoryStorage();
    savePendingTeamsSetup(
      { setupToken: "signed-proof", workspaceId: "ws", replaceOwnLink: true },
      storage,
      1_000,
    );
    expect(readPendingTeamsSetup(storage, 2_000)).toEqual({
      setupToken: "signed-proof",
      workspaceId: "ws",
      replaceOwnLink: true,
    });
    storage.setItem(
      "opengeni.teams-setup",
      JSON.stringify({ setupToken: "p", workspaceId: "ws", replaceOwnLink: "yes", savedAt: 1_000 }),
    );
    expect(readPendingTeamsSetup(storage, 2_000)).toEqual({ setupToken: "p", workspaceId: "ws" });
  });

  test("keeps an account link's proof and workspace through its sign-in, briefly", () => {
    const storage = memoryStorage();
    savePendingTeamsLink({ linkToken: "link-proof", workspaceId: "ws" }, storage, 1_000);
    expect(readPendingTeamsLink(storage, 2_000)).toEqual({
      linkToken: "link-proof",
      workspaceId: "ws",
    });
    // A pending link is never read as a pending setup.
    expect(readPendingTeamsSetup(storage, 2_000)).toBeNull();
    expect(readPendingTeamsLink(storage, 1_000 + 15 * 60_000 + 1)).toBeNull();
    expect(readPendingTeamsLink(storage, 999)).toBeNull();
    clearPendingTeamsLink(storage);
    expect(readPendingTeamsLink(storage, 2_000)).toBeNull();
  });

  test("tells a link sign-in from a setup sign-in by its state's purpose", () => {
    const state = (value: unknown) =>
      `${Buffer.from(JSON.stringify(value)).toString("base64url")}.signature`;
    expect(teamsMicrosoftSignInPurpose(state({ purpose: "teams-account-link" }))).toBe("link");
    expect(teamsMicrosoftSignInPurpose(state({ purpose: "teams-admin-setup" }))).toBe("setup");
    expect(teamsMicrosoftSignInPurpose(state({ purpose: "teams-installer-setup" }))).toBe("setup");
    for (const unknown of [undefined, "", "signed-state", state({ purpose: "other" }), "%%%.x"])
      expect(teamsMicrosoftSignInPurpose(unknown)).toBeNull();
  });

  test("reads exactly one code and state, or Microsoft's error", () => {
    expect(teamsMicrosoftReturn("?code=c&state=s&session_state=x")).toEqual({
      kind: "signed_in",
      code: "c",
      state: "s",
    });
    expect(teamsMicrosoftReturn("?code=c")).toBeNull();
    expect(teamsMicrosoftReturn("?code=c&code=d&state=s")).toBeNull();
    expect(teamsMicrosoftReturn("")).toBeNull();
    expect(
      teamsMicrosoftReturn("?error=access_denied&error_description=AADSTS65001%3A+consent"),
    ).toEqual({
      kind: "failed",
      error: "access_denied",
      description: "AADSTS65001: consent",
    });
  });

  test("explains admin approval separately from an unfinished sign-in", () => {
    expect(teamsMicrosoftFailureText({ error: "consent_required", description: "" })).toContain(
      "Global Administrator to approve",
    );
    expect(
      teamsMicrosoftFailureText({ error: "access_denied", description: "AADSTS90094: admin" }),
    ).toContain("Global Administrator to approve");
    expect(teamsMicrosoftFailureText({ error: "access_denied", description: "" })).toBe(
      "Microsoft sign-in didn't finish. Try again.",
    );
  });

  test("a signed-out return from Microsoft resumes on the setup page", () => {
    expect(
      teamsAuthReturnPath({ pathname: "/teams/connect", search: "?code=c&state=s", hash: "" }),
    ).toBe("/teams/connect?code=c&state=s");
  });
});

describe("Teams setup against an older API", () => {
  test("only a missing route falls back to the operator flow", () => {
    const refusal = (status: number, code: string, message: string) => ({
      status,
      code,
      body: JSON.stringify({ error: { status, code, message, retryable: false } }),
    });
    expect(teamsRouteMissing(refusal(404, "not_found", "Resource not found."))).toBe(true);
    expect(teamsRouteMissing(refusal(404, "not_found", "Teams is not enabled"))).toBe(false);
    expect(teamsRouteMissing(refusal(403, "forbidden", "Resource not found."))).toBe(false);
    expect(teamsRouteMissing({ status: 404, code: "not_found", body: "Not Found" })).toBe(false);
    expect(teamsRouteMissing(null)).toBe(false);
  });
});

describe("Teams setup refusals", () => {
  const refusal = (status: number, reason: string, message: string) =>
    new OpenGeniApiError(
      status,
      JSON.stringify({
        error: {
          message,
          code: "forbidden",
          details: { code: "teams_connection_refused", reason },
        },
      }),
      { mutation: true },
    );
  test("show the API's own sentence; other errors keep the generic advice", () => {
    const userMismatch = "Sign in to Microsoft with the same account you use in Teams.";
    expect(teamsErrorText(refusal(403, "user_mismatch", userMismatch), "fallback")).toBe(
      userMismatch,
    );
    const unmarked = new OpenGeniApiError(
      403,
      JSON.stringify({ error: { message: "missing permission: workspace:admin" } }),
      { mutation: true },
    );
    expect(teamsErrorText(unmarked, "fallback")).toBe(
      "You don't have permission to do this. Ask an admin for access.",
    );
    expect(teamsErrorText(new Error("Choose a workspace you administer."), "fallback")).toBe(
      "Choose a workspace you administer.",
    );
  });
  test("only the installer's own existing link offers to unlink it", () => {
    expect(teamsOwnAccountLinkedElsewhere(refusal(409, "opengeni_account_linked", "x y."))).toBe(
      true,
    );
    expect(teamsOwnAccountLinkedElsewhere(refusal(409, "teams_account_linked", "x y."))).toBe(
      false,
    );
    expect(teamsOwnAccountLinkedElsewhere(new Error("opengeni_account_linked"))).toBe(false);
  });
});
