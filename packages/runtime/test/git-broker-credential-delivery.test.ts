import { describe, expect, test } from "bun:test";
import { runRepositoryCloneHook } from "../src/index";
import { softSetupFailureCause } from "../src/sandbox-setup-soft-failure";
import { SelfhostedControlError } from "../src/sandbox/selfhosted/control-rpc";

// Staging, 10 Nov 2026: a compute box with a full root disk failed every turn
// with "Sandbox could not receive the Git broker credential". The seed write
// failed with "No space left on device", but the generic error dropped that
// cause, so setup could not fail softly and the model never got to free space.

const TOKEN = "oggh1.secret-broker-bearer";

const repository = {
  kind: "repository",
  uri: "https://github.com/acme/private.git",
  ref: "main",
  provider: "github",
  connectionType: "github_personal",
  credentialBindingId: "personal-binding",
  repositoryId: "9007199254740993123",
  access: "read",
} as const;

const context = {
  environment: { HOME: "/workspace" },
  gitCredentialBindings: [
    {
      credentialBindingId: "personal-binding",
      provider: "github" as const,
      token: TOKEN,
      transport: {
        kind: "http_broker" as const,
        repositories: [
          {
            repositoryUri: "https://github.com/acme/private.git",
            brokerUri: "https://broker.example.test/v1/git/personal/route",
          },
        ],
      },
    },
  ],
};

function box(createFile: (path: string) => Promise<void>) {
  const commands: string[] = [];
  const seedWrites: string[] = [];
  const deleted: string[] = [];
  return {
    commands,
    seedWrites,
    deleted,
    session: {
      createEditor: () => ({
        createFile: async ({ path, diff }: { path: string; diff: string }) => {
          // Only the bearer seeds, not the static gh gateway kit.
          if (!diff.includes(TOKEN)) return;
          seedWrites.push(path);
          await createFile(path);
        },
        updateFile: async () => undefined,
        deleteFile: async ({ path }: { path: string }) => {
          deleted.push(path);
        },
      }),
      exec: async ({ cmd }: { cmd: string }) => {
        commands.push(cmd);
        return { output: "", stdout: "", stderr: "", wallTimeSeconds: 0, exitCode: 0 };
      },
    } as any,
  };
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the repository clone hook to fail");
}

describe("Git broker credential delivery", () => {
  test("a full disk keeps its cause, so repository setup fails softly", async () => {
    const noSpace = new SelfhostedControlError({
      message: "os error: No space left on device (os error 28)",
      code: 2 as never,
      reason: null,
      retryable: false,
      detail: { failure_code: "WRITE_IO" },
    });
    const fixture = box(async () => {
      throw new Error(`begin failed: ${noSpace.message}`, { cause: noSpace });
    });
    const error = await failure(
      runRepositoryCloneHook(fixture.session, [repository], context as never),
    );
    expect(error.message).toStartWith("Sandbox could not receive the Git broker credential");
    expect(error.message).toContain("No space left on device");
    expect(softSetupFailureCause(error, "repository-clone")).toEqual({ kind: "no_space" });
    // Pointless to retry a full disk.
    expect(fixture.seedWrites).toHaveLength(1);
    expect(fixture.commands).toHaveLength(0);
  });

  test("a transient seed write failure is retried and the clone runs", async () => {
    let calls = 0;
    const fixture = box(async () => {
      calls += 1;
      if (calls === 1) throw new Error("routed editor write response was lost");
    });
    await runRepositoryCloneHook(fixture.session, [repository], context as never);
    expect(fixture.seedWrites).toHaveLength(2);
    expect(new Set(fixture.seedWrites).size).toBe(2);
    expect(fixture.commands.length).toBeGreaterThan(0);
    // The unconfirmed first path is cleaned up; the written one is handed on.
    expect(fixture.deleted).toContain(fixture.seedWrites[0]!);
    expect(fixture.deleted).not.toContain(fixture.seedWrites[1]!);
  });

  test("the failure keeps its cause and never shows the bearer", async () => {
    const fixture = box(async () => {
      throw new Error(`upstream rejected ${TOKEN}`);
    });
    const error = await failure(
      runRepositoryCloneHook(fixture.session, [repository], context as never),
    );
    expect(error.message).toStartWith("Sandbox could not receive the Git broker credential: ");
    expect(error.message).toContain("upstream rejected [redacted]");
    expect(error.message).not.toContain(TOKEN);
    expect((error.cause as Error).message).toContain("upstream rejected");
    expect(fixture.commands).toHaveLength(0);
    expect(fixture.seedWrites).toHaveLength(3);
    expect(fixture.deleted.filter((path) => fixture.seedWrites.includes(path)).toSorted()).toEqual(
      fixture.seedWrites.toSorted(),
    );
  });

  test("an unanswered machine agent is not retried and reaches the worker's recovery", async () => {
    const offline = new SelfhostedControlError({
      message: "agent offline",
      code: 9 as never,
      reason: "agent_offline",
      retryable: true,
      agentOffline: true,
    });
    const fixture = box(async () => {
      throw offline;
    });
    const error = await failure(
      runRepositoryCloneHook(fixture.session, [repository], context as never),
    );
    expect(fixture.seedWrites).toHaveLength(1);
    expect(error.cause).toBe(offline);
    expect(softSetupFailureCause(error, "repository-clone")).toBeNull();
  });
});
