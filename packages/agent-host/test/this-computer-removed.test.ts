import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ThisComputer, ThisComputerError, machineReadFailure } from "../src/this-computer";
import type { ThisComputerDeps } from "../src/this-computer";

const SERVER = "https://server.example";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

type Reading = { online: boolean } | null | Error | { status: number; message: string };

/**
 * A computer connected to workspace w1 as enrollment a1. Its stand-in agent
 * lists connections from a file, and connecting with a setup token replaces
 * the connection with a new enrollment, a2, as the real agent does.
 * `service`: an existing standalone agent with its own background service
 * (macOS); otherwise the app's own agent (Linux).
 */
function computer(options: { service: boolean; adopted?: boolean }) {
  const home = mkdtempSync(join(tmpdir(), "og-removed-"));
  const list = join(home, "connections.txt");
  const calls = join(home, "calls");
  const paused = join(home, "paused");
  writeFileSync(list, `  c1  ${SERVER}  workspace=w1  agent=a1\n`);
  let binary: string;
  if (options.service) {
    const bundle = join(home, "Applications", "OpenGeni Agent.app", "Contents", "MacOS");
    mkdirSync(bundle, { recursive: true });
    binary = join(bundle, "opengeni-agent");
  } else {
    binary = join(home, "agent");
  }
  writeFileSync(
    binary,
    [
      "#!/bin/sh",
      `echo "$*" >> "${calls}"`,
      'case "$*" in',
      `  connections) cat "${list}" ;;`,
      `  'service status --json') if [ -f "${paused}" ]; then echo '{"schemaVersion":1,"installed":true,"enabled":false,"running":false,"binaryPath":null}'; else echo '{"schemaVersion":1,"installed":true,"enabled":true,"running":true,"binaryPath":null}'; fi ;;`,
      `  'service stop') touch "${paused}" ;;`,
      `  'service start') rm -f "${paused}" ;;`,
      "  --version) echo 'opengeni-agent 0.1.109' ;;",
      `  *'connect --non-interactive'*) echo "token=$OPENGENI_ENROLL_TOKEN" >> "${calls}"; echo "  c1  ${SERVER}  workspace=w1  agent=a2" > "${list}" ;;`,
      "  *run) sleep 30 ;;",
      "  *) exit 99 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(binary, 0o755);
  // Not adopted: an agent set up before the app, e.g. from the web app.
  if (options.adopted !== false) {
    writeFileSync(
      join(home, "this-computer.json"),
      JSON.stringify({ adopted: true, management: options.service ? "service" : "app" }),
    );
  }
  const readings: Record<string, Reading> = { a1: { online: true } };
  const minted: string[] = [];
  const allowed: string[] = [];
  const deps: ThisComputerDeps = {
    platform: options.service ? "darwin" : "linux",
    arch: options.service ? "arm64" : "x64",
    home,
    env: {},
    dataDir: home,
    logDir: home,
    agentSigningKey: "",
    ...(options.service ? {} : { agentPath: binary }),
    fetch: async () => {
      throw new Error("must not download");
    },
    mintEnrollToken: async (_account, workspaceId) => {
      minted.push(workspaceId);
      return "setup-token";
    },
    allowAgents: async (_account, _workspace, enrollmentId) => {
      // A new enrollment is the person's as soon as it exists.
      const reading = readings[enrollmentId];
      if (reading === null || reading instanceof Error || (reading && "status" in reading))
        throw new Error("This computer isn't listed as yours yet. Try again.");
      allowed.push(enrollmentId);
    },
    readMachine: async (_account, _baseUrl, _workspaceId, enrollmentId) => {
      const reading = readings[enrollmentId] ?? null;
      if (reading instanceof Error) throw reading;
      if (reading && "status" in reading) throw reading;
      return reading
        ? {
            online: reading.online,
            screenControl: true,
            permissions: { screenRecording: true, accessibility: true, inputMonitoring: true },
          }
        : null;
    },
    openSystemSettings: () => undefined,
    onChange: () => undefined,
  };
  const instances: ThisComputer[] = [];
  cleanups.push(async () => {
    for (const instance of instances) await instance.shutdown();
    rmSync(home, { recursive: true, force: true });
  });
  return {
    home,
    readings,
    minted,
    allowed,
    create: () => {
      const instance = new ThisComputer(deps);
      instances.push(instance);
      return instance;
    },
    commands: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []),
  };
}

describe.skipIf(process.platform === "win32")("a computer removed on the server", () => {
  for (const service of [true, false]) {
    const kind = service ? "an existing agent service" : "the app's own agent";

    test(`with ${kind}: shows removed, not an endless connecting or a network error`, async () => {
      const c = computer({ service });
      const app = c.create();
      expect((await app.status(SERVER, "w1", "me")).state).toBe("connected");
      // Removed from Machines: the server answers without this enrollment.
      c.readings.a1 = null;
      app.invalidate();
      const status = await app.status(SERVER, "w1", "me");
      expect(status.state).toBe("not_connected");
      expect(status.errorCode).toBe("removed");
      expect(status.error).toContain("removed from this workspace");
      expect(status.reconnecting).toBeUndefined();
      const summary = await app.summary();
      expect(summary.connected).toBe(false);
      expect(summary.reconnecting).toBe(false);
    });

    test(`with ${kind}: reconnecting enrolls afresh and reaches connected`, async () => {
      const c = computer({ service });
      c.readings.a1 = null;
      const app = c.create();
      expect((await app.status(SERVER, "w1", "me")).errorCode).toBe("removed");
      // The new enrollment isn't listed yet right after connecting.
      const next = await app.connect("me", SERVER, "w1", { screenControl: true });
      expect(c.minted).toEqual(["w1"]);
      expect(c.commands()).toContain("token=setup-token");
      expect(next.state).toBe("connected");
      expect(next.errorCode).toBeUndefined();
      // Not listed yet is not "removed" again: it is still connecting.
      app.invalidate();
      const pending = await app.status(SERVER, "w1", "me");
      expect(pending.state).toBe("connected");
      expect(pending.errorCode).toBeUndefined();
      // Then the server lists it and it comes online.
      c.readings.a2 = { online: true };
      app.invalidate();
      const status = await app.status(SERVER, "w1", "me");
      expect(status.state).toBe("connected");
      expect(status.reconnecting ?? false).toBe(false);
      expect(status.error).toBeNull();
      expect(c.allowed).toContain("a2");
    });
  }

  for (const service of [true, false]) {
    const kind = service ? "an existing agent service" : "the app's own agent";
    test(`with ${kind}: turned off, then removed on the server: turning on registers afresh`, async () => {
      const c = computer({ service });
      const app = c.create();
      await app.pause();
      expect((await app.status(SERVER, "w1", "me")).state).toBe("paused");
      c.readings.a1 = null;
      app.invalidate();
      // Removal outranks paused: there is nothing left to resume.
      const removed = await app.status(SERVER, "w1", "me");
      expect(removed.state).toBe("not_connected");
      expect(removed.errorCode).toBe("removed");
      const next = await app.connect("me", SERVER, "w1", { screenControl: true });
      expect(c.minted).toEqual(["w1"]);
      expect(next.state).toBe("connected");
    });
  }

  test("an agent set up from the web app is adopted as on, and the switch controls it", async () => {
    const c = computer({ service: true, adopted: false });
    const app = c.create();
    const status = await app.status(SERVER, "w1", "me");
    expect(status.state).toBe("connected");
    expect(status.management).toBe("service");
    expect(status.reconnecting).toBe(false);
    expect(status.error).toBeNull();
    const saved = JSON.parse(readFileSync(join(c.home, "this-computer.json"), "utf8"));
    expect(saved.adopted).toBe(true);
    // Its existing registration is used: nothing new is registered or downloaded.
    expect(c.minted).toEqual([]);
    await Promise.resolve();
    expect(c.allowed).toEqual(["a1"]);
    await app.pause();
    expect((await app.status(SERVER, "w1", "me")).state).toBe("paused");
    await app.resume();
    expect((await app.status(SERVER, "w1", "me")).state).toBe("connected");
    // A relaunched app still knows it.
    expect((await c.create().status(SERVER, "w1", "me")).state).toBe("connected");
  });

  test("an agent registered elsewhere, or removed, is not adopted", async () => {
    const c = computer({ service: true, adopted: false });
    c.readings.a1 = null;
    const app = c.create();
    expect((await app.status(SERVER, "w1", "me")).state).toBe("not_connected");
    expect((await app.status(SERVER, "w2", "me")).state).toBe("not_connected");
    expect(existsSync(join(c.home, "this-computer.json"))).toBe(false);
    expect(c.commands()).not.toContain("service stop");
  });

  test("a listed machine that isn't online yet is connecting, without an error", async () => {
    const c = computer({ service: true });
    c.readings.a1 = { online: false };
    const status = await c.create().status(SERVER, "w1", "me");
    expect(status.state).toBe("connected");
    expect(status.reconnecting).toBe(true);
    expect(status.error).toBeNull();
    expect(status.errorCode).toBeUndefined();
  });

  test("a server that answered is never reported as unreachable", async () => {
    const c = computer({ service: true });
    const app = c.create();
    const read = async (reading: Reading) => {
      c.readings.a1 = reading;
      app.invalidate();
      return await app.status(SERVER, "w1", "me");
    };

    const offline = await read(new TypeError("fetch failed"));
    expect(offline.state).toBe("connected");
    expect(offline.reconnecting).toBe(true);
    expect(offline.errorCode).toBe("offline");

    const signedOut = await read({ status: 401, message: "API 401: unauthorized" });
    expect(signedOut.state).toBe("connected");
    expect(signedOut.errorCode).toBe("signed_out");

    const failing = await read({ status: 503, message: "API 503: unavailable" });
    expect(failing.errorCode).toBe("unknown");
    expect(failing.error).toContain("API 503");

    // None of these is evidence that the computer was removed.
    expect(c.minted).toEqual([]);
  });

  test("an existing enrollment that the server still lists is reused, not replaced", async () => {
    const c = computer({ service: true });
    await c.create().connect("me", SERVER, "w1", { screenControl: true });
    expect(c.minted).toEqual([]);
    expect(c.allowed).toEqual(["a1"]);
  });
});

describe("why the server's machine list couldn't be read", () => {
  test("each failure keeps its own meaning", () => {
    expect(machineReadFailure(new TypeError("fetch failed")).code).toBe("offline");
    expect(machineReadFailure(new Error("net::ERR_INTERNET_DISCONNECTED")).code).toBe("offline");
    // The SDK's own transport failure: no answer, so not a server error.
    expect(machineReadFailure({ status: 0, message: "HTTP request failed" }).code).toBe("offline");
    expect(machineReadFailure({ code: "network_error", message: "failed" }).code).toBe("offline");
    expect(machineReadFailure({ status: 401, message: "API 401" }).code).toBe("signed_out");
    expect(machineReadFailure({ status: 500, message: "API 500: boom" }).code).toBe("unknown");
    expect(machineReadFailure(new Error("unexpected")).code).toBe("unknown");
    const own = new ThisComputerError("signed_out", "Sign in again.");
    expect(machineReadFailure(own)).toBe(own);
  });
});
