import { describe, expect, test } from "bun:test";
import {
  gitSessionKey,
  withGitSessionClient,
  withGitSessionEnvironment,
  withGitSessionSession,
} from "../src/sandbox/git-session";

describe("per-chat Git credential selection", () => {
  test("keys are stable, distinct per chat and do not disclose the chat id", () => {
    const a = gitSessionKey("session-a");
    expect(a).toMatch(/^[0-9a-f]{32}$/u);
    expect(gitSessionKey("session-a")).toBe(a);
    expect(gitSessionKey("session-b")).not.toBe(a);
    expect(a).not.toContain("session");
    expect(() => gitSessionKey("")).toThrow();
  });

  test("a chat's command selects its directory and routes before running", () => {
    const key = gitSessionKey("session-a");
    const command = withGitSessionEnvironment("git fetch", key);
    expect(command).toContain(`/sessions/${key}"`);
    expect(command).toContain("include.path=$OPENGENI_GIT_SESSION_DIR/http-broker.gitconfig");
    expect(command.endsWith("\ngit fetch")).toBe(true);
    expect(() => withGitSessionEnvironment("true", "../escape")).toThrow();
  });

  test("sessions from a decorated client run commands in the chat's directory", async () => {
    const key = gitSessionKey("session-a");
    const seen: string[] = [];
    const session = {
      id: "box",
      async exec(args: { cmd: string }) {
        seen.push(args.cmd);
        return this.id;
      },
    };
    const client = {
      backendId: "test",
      async create() {
        return session;
      },
      async resume() {
        return session;
      },
    };
    const decorated = withGitSessionClient(client as never, key) as unknown as typeof client;
    expect(decorated.backendId).toBe("test");
    const created = await decorated.create();
    expect(await created.exec({ cmd: "gh pr list" })).toBe("box");
    expect(await decorated.resume()).toBe(created);
    expect(seen[0]).toContain(`/sessions/${key}"`);
    expect(seen[0]!.endsWith("\ngh pr list")).toBe(true);
    // The underlying session itself is unchanged for other chats on the box.
    await session.exec({ cmd: "true" });
    expect(seen[1]).toBe("true");
    const direct = withGitSessionSession(session, key);
    expect(direct.id).toBe("box");
  });
});
