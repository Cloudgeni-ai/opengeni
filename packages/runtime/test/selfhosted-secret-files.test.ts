import { expect, test } from "bun:test";
import { SelfhostedSession, type ControlRpc, type SelfhostedSessionDeps } from "../src/sandbox";

const path = "/tmp/opengeni-private/secrets/attempt-1/value.pem";
function fixture(overrides: Partial<SelfhostedSessionDeps> = {}) {
  const events: string[] = [];
  const controlRpc: ControlRpc = {
    request: async (_subject, request) => {
      const op = request.op;
      events.push(op?.$case ?? "missing");
      if (op?.$case === "fsWrite")
        return {
          requestId: request.requestId,
          result: {
            $case: "fsWrite",
            fsWrite: { bytesWritten: String(op.fsWrite.content.length) },
          },
        };
      if (op?.$case === "fsRemove")
        return { requestId: request.requestId, result: { $case: "fsRemove", fsRemove: {} } };
      throw new Error("Unexpected operation");
    },
  };
  const receipt = {
    close: async () => {
      events.push("close-ledger");
    },
    complete: async () => {
      events.push("complete-ledger");
    },
  };
  const session = new SelfhostedSession({
    workspaceId: "workspace",
    agentId: "machine",
    connectionInstanceId: "connection",
    workspaceRoot: "/workspace",
    relay: { host: "relay.test", tls: true },
    controlRpc,
    secretFileFencingSupported: true,
    secretFileLifecycle: async () => {
      events.push("register");
      return receipt;
    },
    ...overrides,
  });
  return { session, events, receipt, controlRpc };
}

test("durable registration precedes bytes; completion follows native closure", async () => {
  const { session, events } = fixture();
  await session.writePlacementPrivate({ path, content: "synthetic-material" });
  await session.clearSecretFilesForAttempt();
  expect(events).toEqual(["register", "fsWrite", "close-ledger", "fsRemove", "complete-ledger"]);
  await expect(session.writePlacementPrivate({ path, content: "late" })).rejects.toThrow("closed");
});

test("cleanup while registration is pending prevents late dispatch", async () => {
  let resolve!: (value: { close: () => Promise<void>; complete: () => Promise<void> }) => void;
  let entered!: () => void;
  const registrationStarted = new Promise<void>((done) => {
    entered = done;
  });
  const registration = new Promise<{ close: () => Promise<void>; complete: () => Promise<void> }>(
    (done) => {
      resolve = done;
    },
  );
  const { session, events, receipt } = fixture({
    secretFileLifecycle: async () => {
      entered();
      return await registration;
    },
  });
  const write = session.writePlacementPrivate({ path, content: "synthetic-material" });
  const rejected = write.catch((error: unknown) => error);
  await registrationStarted;
  const cleanup = session.clearSecretFilesForAttempt();
  resolve(receipt);
  expect(String(await rejected)).toContain("closed");
  await cleanup;
  expect(events).toEqual(["close-ledger", "fsRemove", "complete-ledger"]);
});

test("a transport timeout does not forget an accepted write's cleanup obligation", async () => {
  const base = fixture();
  const { session, events } = fixture({
    controlRpc: {
      request: async (subject, request, opts) => {
        if (request.op?.$case === "fsWrite") throw new Error("transport timeout after acceptance");
        return await base.controlRpc.request(subject, request, opts);
      },
    },
  });
  await expect(
    session.writePlacementPrivate({ path, content: "synthetic-material" }),
  ).rejects.toThrow("timeout");
  await session.clearSecretFilesForAttempt();
  expect(events).toEqual(["register", "close-ledger", "complete-ledger"]);
  expect(base.events).toEqual(["fsRemove"]);
});

test("failed native cleanup stays pending and can be retried", async () => {
  const base = fixture();
  let offline = true;
  const { session, events } = fixture({
    controlRpc: {
      request: async (subject, request, opts) => {
        if (request.op?.$case === "fsRemove" && offline) throw new Error("offline");
        return await base.controlRpc.request(subject, request, opts);
      },
    },
  });
  await session.writePlacementPrivate({ path, content: "synthetic-material" });
  await expect(session.clearSecretFilesForAttempt("attempt-1")).rejects.toThrow("pending");
  expect(events).not.toContain("complete-ledger");
  offline = false;
  await session.clearSecretFilesForAttempt();
  expect(events.at(-1)).toBe("complete-ledger");
});

test("old agents fail closed before registration or write", async () => {
  const { session, events } = fixture({ secretFileFencingSupported: false });
  await expect(
    session.writePlacementPrivate({ path, content: "synthetic-material" }),
  ).rejects.toThrow("agent update");
  expect(events).toEqual([]);
});
