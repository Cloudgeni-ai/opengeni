import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import {
  captureVerifiedWorkspaceArchive,
  createSandboxClient,
  establishSandboxSessionFromEnvelope,
  type EstablishedSandboxSession,
} from "../src/sandbox";
import {
  deleteModalCheckpointSnapshot,
  modalSessionMatchesCheckpointProviderBinding,
  resolveModalCheckpointProviderBindingForSession,
} from "../src/sandbox/providers/modal";

const liveGate = process.env.OPENGENI_LIVE_MODAL_SNAPSHOT === "1" && hasModalCredentials();
const workspacePersistence =
  process.env.OPENGENI_MODAL_SNAPSHOT_MODE === "snapshot_directory"
    ? "snapshot_directory"
    : "snapshot_filesystem";

function hasModalCredentials(): boolean {
  if (process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET) return true;
  const path = join(homedir(), ".modal.toml");
  if (!existsSync(path)) return false;
  try {
    const wantedProfile = process.env.MODAL_PROFILE;
    return readFileSync(path, "utf8")
      .split(/\n(?=\[)/)
      .some((section) => {
        const name = /^\[([^\]]+)\]/.exec(section.trimStart())?.[1];
        if (!name || !/\btoken_id\s*=/.test(section)) return false;
        return wantedProfile ? name === wantedProfile : /\bactive\s*=\s*true\b/.test(section);
      });
  } catch {
    return false;
  }
}

function outputText(result: unknown): string {
  if (typeof result === "string") {
    const marker = "\nOutput:\n";
    const index = result.indexOf(marker);
    return (index >= 0 ? result.slice(index + marker.length) : result).trim();
  }
  if (result && typeof result === "object") {
    const value = result as { output?: unknown; stdout?: unknown };
    if (typeof value.output === "string") return value.output.trim();
    if (typeof value.stdout === "string") return value.stdout.trim();
  }
  return "";
}

async function exec(session: unknown, command: string): Promise<string> {
  const target = session as {
    exec?: (input: {
      cmd: string;
      yieldTimeMs: number;
      maxOutputTokens: number;
    }) => Promise<unknown>;
    execCommand?: (input: {
      cmd: string;
      yieldTimeMs: number;
      maxOutputTokens: number;
    }) => Promise<unknown>;
  };
  const run = target.exec ?? target.execCommand;
  if (!run) throw new Error("Modal session exposes no exec seam");
  return outputText(
    await run.call(target, {
      cmd: command,
      yieldTimeMs: 60_000,
      maxOutputTokens: 2_000,
    }),
  );
}

async function terminate(established: EstablishedSandboxSession | null): Promise<void> {
  if (!established) return;
  const client = established.client as { delete?: (state: unknown) => Promise<unknown> };
  if (client.delete && established.sessionState !== undefined) {
    await client.delete(established.sessionState);
    return;
  }
  const session = established.session as {
    delete?: () => Promise<unknown>;
    terminate?: () => Promise<unknown>;
    close?: () => Promise<unknown>;
  };
  if (session.delete) await session.delete();
  else if (session.terminate) await session.terminate();
  else if (session.close) await session.close();
}

describe("Modal native checkpoint round trip (opt-in live service)", () => {
  test.skipIf(!liveGate)(
    "captures an opaque receipt, restores its contents, and cleans up both boxes and Image",
    async () => {
      const settings = testSettings({
        sandboxBackend: "modal",
        modalAppName: process.env.OPENGENI_MODAL_SMOKE_APP ?? "opengeni-snapshot-live-smoke",
        modalImageRef: process.env.OPENGENI_MODAL_SMOKE_IMAGE ?? "python:3.12-slim",
        modalWorkspacePersistence: workspacePersistence,
        modalTimeoutSeconds: 600,
        modalIdleTimeoutSeconds: 300,
      });
      const client = createSandboxClient(settings) as {
        backendId: string;
        create(input?: unknown): Promise<unknown>;
        resume(state: unknown): Promise<unknown>;
      };
      let source: EstablishedSandboxSession | null = null;
      let restored: EstablishedSandboxSession | null = null;
      let parallelHandle: { sandbox?: { detach?: () => void } } | null = null;
      let snapshot:
        | {
            base64: string;
            descriptor: Awaited<ReturnType<typeof captureVerifiedWorkspaceArchive>>["descriptor"];
            nativeSnapshot?: { snapshotId: string };
          }
        | undefined;
      let providerBinding:
        | Awaited<ReturnType<typeof resolveModalCheckpointProviderBindingForSession>>
        | undefined;
      let runFailed = false;
      let runError: unknown;
      try {
        const session = (await client.create()) as { state?: unknown };
        source = {
          client,
          session,
          sessionState: session.state,
          instanceId: String(
            (session.state as { sandboxId?: unknown } | undefined)?.sandboxId ?? "unknown",
          ),
          backendId: client.backendId,
        };
        await exec(
          session,
          "mkdir -p /workspace/checkpoint-smoke && printf 'modal-native-roundtrip' > /workspace/checkpoint-smoke/original && ln /workspace/checkpoint-smoke/original /workspace/checkpoint-smoke/hardlink",
        );
        providerBinding = await resolveModalCheckpointProviderBindingForSession(settings, session);
        const captureRequestId = randomUUID();
        // A Temporal retry can overlap the predecessor from a different worker,
        // so prove idempotency through two independently resumed handles. The
        // in-process capture gate intentionally does not serialize these.
        parallelHandle = (await client.resume(source.sessionState)) as typeof parallelHandle;
        const [firstCapture, overlappingCapture] = await Promise.all([
          captureVerifiedWorkspaceArchive(session, Date.now(), {
            requestId: captureRequestId,
          }),
          captureVerifiedWorkspaceArchive(parallelHandle, Date.now(), {
            requestId: captureRequestId,
          }),
        ]);
        snapshot = firstCapture;
        expect(snapshot.kind).toBe("provider_snapshot");
        expect(snapshot.descriptor.version).toBe(2);
        expect(overlappingCapture.nativeSnapshot?.snapshotId).toBe(
          snapshot.nativeSnapshot?.snapshotId,
        );
        expect(overlappingCapture.base64).toBe(snapshot.base64);
        // Native capture is a read operation: it must neither replace nor stop
        // the live source. Mutate it afterwards and prove the restored Image is
        // the fixed pre-mutation checkpoint rather than a live filesystem view.
        expect(
          await exec(
            session,
            "printf 'source-still-live' > /workspace/checkpoint-smoke/post-capture && cat /workspace/checkpoint-smoke/post-capture",
          ),
        ).toBe("source-still-live");

        restored = await establishSandboxSessionFromEnvelope(
          settings,
          {
            backendId: "modal",
            sessionState: {
              workspaceArchive: snapshot.base64,
              workspaceArchiveMeta: snapshot.descriptor,
              workspaceReady: true,
            },
          },
          {
            sessionId: crypto.randomUUID(),
            recovery: "create-or-restore",
            backendOverride: "modal",
          },
        );
        expect(restored.origin).toBe("restored");
        await expect(
          modalSessionMatchesCheckpointProviderBinding(
            settings,
            restored.session,
            providerBinding.key,
          ),
        ).resolves.toBe(true);
        expect(
          await exec(
            restored.session,
            "printf '%s|' \"$(cat /workspace/checkpoint-smoke/original)\"; cat /workspace/checkpoint-smoke/hardlink; test ! -e /workspace/checkpoint-smoke/post-capture",
          ),
        ).toBe("modal-native-roundtrip|modal-native-roundtrip");
      } catch (error) {
        runFailed = true;
        runError = error;
      }
      parallelHandle?.sandbox?.detach?.();
      const cleanupResults: PromiseSettledResult<unknown>[] = await Promise.allSettled([
        terminate(restored),
        terminate(source),
      ]);
      if (snapshot?.nativeSnapshot?.snapshotId && providerBinding) {
        const [deletion] = await Promise.allSettled([
          deleteModalCheckpointSnapshot(
            settings,
            providerBinding.key,
            snapshot.nativeSnapshot.snapshotId,
          ),
        ]);
        cleanupResults.push(deletion!);
      }
      const cleanupErrors = cleanupResults
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (runFailed || cleanupErrors.length > 0) {
        throw new AggregateError(
          [...(runFailed ? [runError] : []), ...cleanupErrors],
          "Modal checkpoint smoke or cleanup failed",
        );
      }
    },
    600_000,
  );

  test.skipIf(liveGate)("is visibly gated when live Modal credentials are not opted in", () => {
    expect(liveGate).toBe(false);
  });
});
