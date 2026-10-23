import { describe, expect, test } from "bun:test";
import { teamsAuthReturnPath, teamsFragmentToken } from "./teams-connect";
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
