import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import type { RunCredentialsResolution } from "@opengeni/contracts";
import {
  RunCredentialValidationError,
  clearRunCredentials,
  clearRunCredentialsForAttempt,
  materializeRunCredentials,
  normalizeRunCredentialsResolution,
  runCredentialRoot,
  withRunCredentialsSession,
} from "../src/sandbox";
import { createSandboxClientForBackend } from "../src/index";

setDefaultTimeout(30_000);

const expected = {
  accountId: "account-a",
  workspaceId: "workspace-a",
  sessionId: "session-a",
};

function resolution(
  overrides: Partial<Extract<RunCredentialsResolution, { status: "ok" }>> = {},
): Extract<RunCredentialsResolution, { status: "ok" }> {
  return {
    status: "ok",
    ...expected,
    environment: {
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret",
    },
    files: [{ path: "kubernetes/config", content: "cluster: first\n", mode: "0400" }],
    fileEnvironment: { KUBECONFIG: "kubernetes/config" },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

describe("run credential response validation", () => {
  test("accepts an explicit per-attempt host opt-out without material", () => {
    expect(
      normalizeRunCredentialsResolution({ status: "not_applicable", ...expected }, expected),
    ).toBeNull();
  });

  test("accepts provider-neutral environment, files, file references, and partial auth notices", () => {
    const normalized = normalizeRunCredentialsResolution(
      resolution({
        authNeeded: [
          {
            reason: "missing_connection",
            providerDomain: "example.invalid",
            authorizationUrl: "https://example.invalid/connect",
          },
        ],
      }),
      expected,
    );

    expect(normalized.environment.AWS_ACCESS_KEY_ID).toBe("access");
    expect(normalized.files).toEqual([
      { path: "kubernetes/config", content: "cluster: first\n", mode: "0400" },
    ]);
    expect(normalized.fileEnvironment).toEqual({
      KUBECONFIG: "kubernetes/config",
    });
    expect(normalized.authNeeded).toHaveLength(1);
    expect(normalized.expiresAt).toBeInstanceOf(Date);
  });

  test("turns an all-auth-needed response into an explicit empty generation", () => {
    const normalized = normalizeRunCredentialsResolution(
      {
        status: "auth_needed",
        ...expected,
        authNeeded: [{ reason: "expired", providerDomain: "example.invalid" }],
      },
      expected,
    );
    expect(normalized.environment).toEqual({});
    expect(normalized.files).toEqual([]);
    expect(normalized.expiresAt).toBeNull();
  });

  test("fails closed on scope mismatch, unsafe paths, collisions, and stale expiry", () => {
    expect(() =>
      normalizeRunCredentialsResolution(resolution({ workspaceId: "workspace-b" }), expected),
    ).toThrow(RunCredentialValidationError);
    expect(() =>
      normalizeRunCredentialsResolution(
        resolution({ files: [{ path: "../escape", content: "secret" }] }),
        expected,
      ),
    ).toThrow(RunCredentialValidationError);
    expect(() =>
      normalizeRunCredentialsResolution(
        resolution({
          files: [
            { path: "Cloud/config", content: "a" },
            { path: "cloud/config", content: "b" },
          ],
          fileEnvironment: {},
        }),
        expected,
      ),
    ).toThrow(RunCredentialValidationError);
    expect(() =>
      normalizeRunCredentialsResolution(
        resolution({ expiresAt: new Date(Date.now() - 1_000).toISOString() }),
        expected,
      ),
    ).toThrow(RunCredentialValidationError);
  });

  test("fails closed on untrusted file modes and malformed auth notices", () => {
    expect(() =>
      normalizeRunCredentialsResolution(
        resolution({
          files: [{ path: "cloud/config", content: "secret", mode: "0777" as never }],
        }),
        expected,
      ),
    ).toThrow(RunCredentialValidationError);
    expect(() =>
      normalizeRunCredentialsResolution(
        resolution({ authNeeded: [{ reason: "unknown" as never }] }),
        expected,
      ),
    ).toThrow(RunCredentialValidationError);
    expect(() =>
      normalizeRunCredentialsResolution(
        resolution({
          authNeeded: [{ reason: "missing_connection", scopes: [" "] }],
        }),
        expected,
      ),
    ).toThrow(RunCredentialValidationError);
    expect(() =>
      normalizeRunCredentialsResolution(
        resolution({ authNeeded: [{ reason: "expired", providerDomain: "" }] }),
        expected,
      ),
    ).toThrow(RunCredentialValidationError);
  });

  test("turns malformed host response shapes into typed validation failures", () => {
    expect(() => normalizeRunCredentialsResolution(null as never, expected)).toThrow(
      RunCredentialValidationError,
    );
    expect(() =>
      normalizeRunCredentialsResolution(
        resolution({ environment: { TOKEN: 42 as never } }),
        expected,
      ),
    ).toThrow(RunCredentialValidationError);
    expect(() =>
      normalizeRunCredentialsResolution(resolution({ files: {} as never }), expected),
    ).toThrow(RunCredentialValidationError);
    expect(() =>
      normalizeRunCredentialsResolution(resolution({ authNeeded: {} as never }), expected),
    ).toThrow(RunCredentialValidationError);
    expect(() =>
      normalizeRunCredentialsResolution(resolution({ redactions: {} as never }), expected),
    ).toThrow(RunCredentialValidationError);
    expect(() =>
      normalizeRunCredentialsResolution(resolution({ expiresAt: 42 as never }), expected),
    ).toThrow(RunCredentialValidationError);
  });

  test("rechecks file modes before the exported materializer executes a command", async () => {
    let commands = 0;
    await expect(
      materializeRunCredentials(
        {} as never,
        {
          environment: {},
          files: [{ path: "cloud/config", content: "secret", mode: "0777" as never }],
          fileEnvironment: {},
          expiresAt: null,
          authNeeded: [],
          redactions: [],
        },
        {
          sessionId: "session-a",
          attemptId: "attempt-a",
          executionGeneration: 1,
          commandRunner: async () => {
            commands += 1;
            return "__OPENGENI_RUN_CREDENTIAL_COMMAND_OK__";
          },
        },
      ),
    ).rejects.toBeInstanceOf(RunCredentialValidationError);
    expect(commands).toBe(0);
  });

  test("emits functional base64 probes, byte verification, and a flock-free lock fallback", async () => {
    const commands: string[] = [];
    await materializeRunCredentials(
      {} as never,
      normalizeRunCredentialsResolution(resolution(), expected),
      {
        sessionId: "session-a",
        attemptId: "attempt-a",
        executionGeneration: 1,
        commandRunner: async (_session, args) => {
          commands.push(args.cmd);
          return "__OPENGENI_RUN_CREDENTIAL_COMMAND_OK__";
        },
      },
    );
    const script = commands.join("\n");
    expect(script).toContain("printf %s QQ== | base64 -d");
    expect(script).toContain("base64 -D");
    expect(script).toContain("openssl base64 -d -A");
    expect(script).toContain("wc -c");
    expect(script).toContain("command -v flock");
    expect(script).toContain("_opengeni_pointer_lock_dir");
    expect(script).toContain('mkdir "$_opengeni_pointer_lock_dir"');
  });
});

type LiveLocalSession = {
  state: { manifest?: { entries?: Record<string, unknown> } };
  exec: (args: { cmd: string }) => Promise<{ stdout: string; stderr: string; exitCode?: number }>;
  execCommand?: (args: { cmd: string }) => Promise<string>;
  close: () => Promise<void>;
};

const liveSessions: LiveLocalSession[] = [];

async function makeBox(): Promise<LiveLocalSession> {
  const settings = testSettings({
    sandboxBackend: "local",
    webSearchEnabled: false,
  });
  const client = createSandboxClientForBackend("local", settings) as unknown as {
    create: (manifest?: unknown) => Promise<LiveLocalSession>;
  };
  const session = await client.create({});
  liveSessions.push(session);
  return session;
}

afterEach(async () => {
  for (const session of liveSessions.splice(0)) {
    await session.close().catch(() => undefined);
  }
});

describe("run credential sandbox lifecycle — real local box", () => {
  test("rejects a decoder that exits successfully without writing all bytes", async () => {
    const session = await makeBox();
    const sessionId = crypto.randomUUID();
    const silentlyCorruptingDecoder = async (
      commandSession: { exec?: (args: { cmd: string }) => Promise<unknown> },
      args: { cmd: string },
    ): Promise<unknown> => {
      if (!commandSession.exec) throw new Error("test session has no exec transport");
      return await commandSession.exec({
        ...args,
        cmd: args.cmd
          .replaceAll("printf %s QQ== | base64 -d >/dev/null 2>&1", "false")
          .replaceAll("printf %s QQ== | base64 -D >/dev/null 2>&1", "false")
          .replaceAll("command -v openssl", "true")
          .replaceAll("openssl base64 -d -A", "true"),
      });
    };
    await expect(
      materializeRunCredentials(
        session as never,
        normalizeRunCredentialsResolution(resolution(), expected),
        {
          sessionId,
          attemptId: crypto.randomUUID(),
          executionGeneration: 1,
          commandRunner: silentlyCorruptingDecoder as never,
        },
      ),
    ).rejects.toThrow("run credential materialization command failed");
    await clearRunCredentials(session as never, sessionId);
  });

  test("the portable lock and OpenSSL decoder activate and clear material", async () => {
    const session = await makeBox();
    const sessionId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const shimDirectory = `/tmp/opengeni-openssl-shim-${sessionId}`;
    const shim = await session.exec({
      cmd: [
        `mkdir -p ${shimDirectory}`,
        `cat > ${shimDirectory}/openssl <<'SH'`,
        "#!/bin/bash",
        '[ "$1" = base64 ] && [ "$2" = -d ] && [ "$3" = -A ] || exit 65',
        "exec base64 -d",
        "SH",
        `chmod 0700 ${shimDirectory}/openssl`,
      ].join("\n"),
    });
    expect(shim.exitCode).toBe(0);
    const withoutFlockOrNativeBase64 = async (
      commandSession: { exec?: (args: { cmd: string }) => Promise<unknown> },
      args: { cmd: string },
    ): Promise<unknown> => {
      if (!commandSession.exec) throw new Error("test session has no exec transport");
      return await commandSession.exec({
        ...args,
        cmd: args.cmd
          .replace("env -u BASH_ENV", `env -u BASH_ENV PATH=${shimDirectory}:$PATH`)
          .replaceAll("command -v flock", "false")
          .replaceAll("printf %s QQ== | base64 -d >/dev/null 2>&1", "false")
          .replaceAll("printf %s QQ== | base64 -D >/dev/null 2>&1", "false"),
      });
    };
    const largeCredentialFile = "0123456789abcdef".repeat(2_000);
    await materializeRunCredentials(
      session as never,
      normalizeRunCredentialsResolution(
        resolution({
          files: [{ path: "kubernetes/config", content: largeCredentialFile }],
        }),
        expected,
      ),
      {
        sessionId,
        attemptId,
        executionGeneration: 1,
        commandRunner: withoutFlockOrNativeBase64 as never,
      },
    );
    const wrapped = withRunCredentialsSession(session, sessionId);
    expect((await wrapped.exec({ cmd: `printf '%s' "$AWS_ACCESS_KEY_ID"` })).stdout).toBe("access");
    expect((await wrapped.exec({ cmd: `cat "$KUBECONFIG"` })).stdout).toBe(largeCredentialFile);
    await clearRunCredentials(session as never, sessionId, withoutFlockOrNativeBase64 as never);
    expect((await wrapped.exec({ cmd: `printf '%s' "\${AWS_ACCESS_KEY_ID-unset}"` })).stdout).toBe(
      "unset",
    );
  });

  test("atomically activates renewal, keeps material off-manifest, and clears it", async () => {
    const session = await makeBox();
    const sessionId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const first = normalizeRunCredentialsResolution(resolution(), expected);
    await materializeRunCredentials(session as never, first, {
      sessionId,
      attemptId,
      executionGeneration: 4,
    });

    const wrapped = withRunCredentialsSession(session, sessionId);
    const firstRead = await wrapped.exec({
      cmd: `printf '%s|%s|' "$AWS_ACCESS_KEY_ID" "$KUBECONFIG"; cat "$KUBECONFIG"`,
    });
    expect(firstRead.stdout).toContain(`access|${runCredentialRoot(sessionId)}/versions/`);
    expect(firstRead.stdout).toEndWith("cluster: first\n");
    expect(JSON.stringify(session.state.manifest?.entries ?? {})).not.toContain("run-credentials");

    const renewed = normalizeRunCredentialsResolution(
      resolution({
        environment: { AWS_ACCESS_KEY_ID: "renewed" },
        files: [{ path: "kubernetes/config", content: "cluster: renewed\n" }],
      }),
      expected,
    );
    await materializeRunCredentials(session as never, renewed, {
      sessionId,
      attemptId,
      executionGeneration: 4,
    });
    const renewedRead = await wrapped.exec({
      cmd: `printf '%s|' "$AWS_ACCESS_KEY_ID"; cat "$KUBECONFIG"`,
    });
    expect(renewedRead.stdout).toBe("renewed|cluster: renewed\n");

    await clearRunCredentials(session as never, sessionId);
    const cleared = await wrapped.exec({
      cmd: `printf '%s|%s' "\${AWS_ACCESS_KEY_ID-unset}" "\${KUBECONFIG-unset}"`,
    });
    expect(cleared.stdout).toBe("unset|unset");
  });

  test("an empty auth-needed generation removes material from an earlier generation", async () => {
    const session = await makeBox();
    const sessionId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    await materializeRunCredentials(
      session as never,
      normalizeRunCredentialsResolution(resolution(), expected),
      { sessionId, attemptId, executionGeneration: 1 },
    );
    await materializeRunCredentials(
      session as never,
      normalizeRunCredentialsResolution(
        {
          status: "auth_needed",
          ...expected,
          authNeeded: [{ reason: "expired" }],
        },
        expected,
      ),
      {
        sessionId,
        attemptId,
        executionGeneration: 1,
        prunePreviousGenerations: true,
      },
    );
    const wrapped = withRunCredentialsSession(session, sessionId);
    const result = await wrapped.exec({
      cmd: `printf '%s' "\${AWS_ACCESS_KEY_ID-unset}"`,
    });
    expect(result.stdout).toBe("unset");
    const versionCount = await session.exec({
      cmd: `find ${runCredentialRoot(sessionId)}/versions -mindepth 1 -maxdepth 1 -type d | wc -l`,
    });
    expect(versionCount.stdout.trim()).toBe("1");
    await clearRunCredentials(session as never, sessionId);
  });

  test("renewal retains only the active and immediately previous immutable generations", async () => {
    const session = await makeBox();
    const sessionId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    for (const token of ["first", "second", "third", "fourth"]) {
      await materializeRunCredentials(
        session as never,
        normalizeRunCredentialsResolution(
          resolution({
            environment: { TOKEN: token },
            files: [],
            fileEnvironment: {},
          }),
          expected,
        ),
        {
          sessionId,
          attemptId,
          executionGeneration: 1,
          pruneSupersededGenerations: true,
        },
      );
    }
    const versionCount = await session.exec({
      cmd: `find ${runCredentialRoot(sessionId)}/versions -mindepth 1 -maxdepth 1 -type d | wc -l`,
    });
    expect(versionCount.stdout.trim()).toBe("2");
    const wrapped = withRunCredentialsSession(session, sessionId);
    const current = await wrapped.exec({ cmd: `printf '%s' "$TOKEN"` });
    expect(current.stdout).toBe("fourth");
    await clearRunCredentials(session as never, sessionId);
  });

  test("attempt cleanup cannot erase an already-active successor generation", async () => {
    const session = await makeBox();
    const sessionId = crypto.randomUUID();
    const firstAttempt = crypto.randomUUID();
    const successorAttempt = crypto.randomUUID();
    await materializeRunCredentials(
      session as never,
      normalizeRunCredentialsResolution(
        resolution({ environment: { TOKEN: "first-secret" } }),
        expected,
      ),
      { sessionId, attemptId: firstAttempt, executionGeneration: 1 },
    );
    await materializeRunCredentials(
      session as never,
      normalizeRunCredentialsResolution(
        resolution({ environment: { TOKEN: "successor-secret" } }),
        expected,
      ),
      {
        sessionId,
        attemptId: successorAttempt,
        executionGeneration: 2,
        pruneOtherAttempts: true,
      },
    );
    const versionCount = await session.exec({
      cmd: `find ${runCredentialRoot(sessionId)}/versions -mindepth 1 -maxdepth 1 -type d | wc -l`,
    });
    expect(versionCount.stdout.trim()).toBe("1");
    await clearRunCredentialsForAttempt(session as never, {
      sessionId,
      attemptId: firstAttempt,
      executionGeneration: 1,
    });
    const wrapped = withRunCredentialsSession(session, sessionId);
    const result = await wrapped.exec({ cmd: `printf '%s' "$TOKEN"` });
    expect(result.stdout).toBe("successor-secret");
    await clearRunCredentialsForAttempt(session as never, {
      sessionId,
      attemptId: successorAttempt,
      executionGeneration: 2,
    });
  });
});
