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
 * the connection with a new enrollment, a2, in the workspace the token was
 * made for, as the real agent does.
 * `service`: an existing standalone agent with its own background service
 * (macOS); otherwise the app's own agent (Linux).
 */
function computer(options: {
  service: boolean;
  adopted?: boolean;
  ownerOnly?: boolean;
  /** Connected with screen control already. */
  screenControl?: boolean;
  /** Also used in these workspaces, made in w1. */
  alsoIn?: string[];
  /** Workspaces the person left: no setup tokens there, and their machines can't be read. */
  left?: string[];
  /** Connecting again where it was made keeps its enrollment, as the real server does. */
  keepEnrollment?: boolean;
}) {
  const home = mkdtempSync(join(tmpdir(), "og-removed-"));
  const list = join(home, "connections.txt");
  const calls = join(home, "calls");
  const paused = join(home, "paused");
  const enrollIn = join(home, "enroll-workspace");
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
      `  *'connect --non-interactive'*) echo "token=$OPENGENI_ENROLL_TOKEN" >> "${calls}"; echo "  c1  ${SERVER}  workspace=$(cat "${enrollIn}")  agent=${options.keepEnrollment ? "a1" : "a2"}" > "${list}" ;;`,
      // `exec`, so stopping the agent stops the sleep and leaves no process behind.
      "  *run) exec sleep 30 ;;",
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
      JSON.stringify({
        adopted: true,
        management: options.service ? "service" : "app",
        ...(options.screenControl ? { screenControl: true } : {}),
        ...(options.alsoIn
          ? {
              alsoIn: Object.fromEntries(
                options.alsoIn.map((workspace) => [`${SERVER} ${workspace}`, "a1"]),
              ),
            }
          : {}),
      }),
    );
  }
  const readings: Record<string, Reading> = { a1: { online: true } };
  const minted: string[] = [];
  const allowed: string[] = [];
  /** Where each enrollment was let in, as `workspace:enrollment`. */
  const grants: string[] = [];
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
      if (options.left?.includes(workspaceId))
        throw new Error("You can't set up computers in this workspace.");
      writeFileSync(enrollIn, workspaceId);
      return "setup-token";
    },
    allowAgents: async (_account, workspaceId, enrollmentId) => {
      // A new enrollment is the person's as soon as it exists.
      const reading = readings[enrollmentId];
      if (reading === null || reading instanceof Error || (reading && "status" in reading))
        throw new Error("This computer isn't listed as yours yet. Try again.");
      allowed.push(enrollmentId);
      grants.push(`${workspaceId}:${enrollmentId}`);
    },
    readMachine: async (account, _baseUrl, workspaceId, enrollmentId) => {
      // Enrollments are the person's own: another account's view doesn't list them.
      if (options.ownerOnly && account !== "me") return null;
      if (options.left?.includes(workspaceId))
        throw { status: 404, message: "workspace not found" };
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
    grants,
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
    expect(status.waitingOn).toBe("server");
    expect(status.error).toBeNull();
    expect(status.errorCode).toBeUndefined();
  });

  test("the app's own agent that the server won't sign in is not on, and says why", async () => {
    const c = computer({ service: false });
    const list = join(c.home, "connections.txt");
    writeFileSync(
      list,
      `  c1  ${SERVER}  workspace=w1  agent=a1\n` +
        "    Authentication rejected; transport retries paused while credentials are renewed.\n",
    );
    const app = c.create();
    await app.boot();
    // Running, but not signed in: still turning on, never "on".
    const renewing = await app.status(SERVER, "w1", "me");
    expect(renewing.state).toBe("connected");
    expect(renewing.reconnecting).toBe(true);
    expect(renewing.waitingOn).toBe("sign_in");
    expect(renewing.error).toBeNull();
    // The menu bar doesn't call it available either.
    expect((await app.summary()).reconnecting).toBe(true);
    // Try again starts a fresh agent process, so it retries now.
    const runs = () => c.commands().filter((command) => command.endsWith(" run")).length;
    while (runs() === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    const before = runs();
    await app.resume();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runs()).toBe(before + 1);

    // It stopped trying: a problem at once; connecting again clears it.
    writeFileSync(
      list,
      `  c1  ${SERVER}  workspace=w1  agent=a1\n` +
        "    Reconnect required; automatic retries stopped. Run `opengeni-agent connect`.\n",
    );
    app.invalidate();
    const rejected = await app.status(SERVER, "w1", "me");
    expect(rejected.errorCode).toBe("reconnect_required");
    expect(rejected.reconnecting).toBeUndefined();
    c.readings.a2 = { online: true };
    const next = await app.connect("me", SERVER, "w1", { screenControl: true });
    expect(next.state).toBe("connected");
    expect(next.errorCode).toBeUndefined();
    expect(next.reconnecting).toBeUndefined();
  });

  for (const service of [true, false]) {
    const kind = service ? "an existing agent service" : "the app's own agent";
    test(`with ${kind}: a connection the agent stopped retrying is enrolled afresh, even while listed`, async () => {
      const c = computer({ service, screenControl: true });
      writeFileSync(
        join(c.home, "connections.txt"),
        `  c1  ${SERVER}  workspace=w1  agent=a1\n` +
          "    Reconnect required; automatic retries stopped. Run `opengeni-agent connect`.\n",
      );
      // The server still lists the old enrollment: reusing it would change nothing.
      c.readings.a1 = { online: false };
      const app = c.create();
      const rejected = await app.status(SERVER, "w1", "me");
      expect(rejected.state).toBe("connected");
      expect(rejected.errorCode).toBe("reconnect_required");
      expect(rejected.waitingOn).toBeUndefined();
      expect((await app.summary()).reconnecting).toBe(true);
      c.readings.a2 = { online: true };
      const next = await app.connect("me", SERVER, "w1", { screenControl: true });
      expect(c.minted).toEqual(["w1"]);
      expect(c.commands()).toContain("token=setup-token");
      expect(next.state).toBe("connected");
      expect(next.errorCode).toBeUndefined();
      expect(next.error).toBeNull();
    });
  }

  const REFUSED =
    `  c1  ${SERVER}  workspace=w1  agent=a1\n` +
    "    Reconnect required; automatic retries stopped. Run `opengeni-agent connect`.\n";

  for (const service of [true, false]) {
    const kind = service ? "an existing agent service" : "the app's own agent";
    test(`with ${kind}: a refused connection made in another workspace reconnects where it was made`, async () => {
      const c = computer({ service, screenControl: true, alsoIn: ["w2", "w3"] });
      writeFileSync(join(c.home, "connections.txt"), REFUSED);
      c.readings.a1 = { online: false };
      const app = c.create();
      // Used here through the connection made in w1: the same problem, here too.
      const rejected = await app.status(SERVER, "w2", "me");
      expect(rejected.errorCode).toBe("reconnect_required");
      expect((await app.summary()).needsReconnect).toBe(true);
      c.readings.a2 = { online: true };
      // Turning on in w2: a personal computer has one live connection on a
      // server, so it is connected again in w1, then shared with w2 again.
      const next = await app.connect("me", SERVER, "w2", { screenControl: true });
      expect(c.minted).toEqual(["w1"]);
      expect(c.commands()).toContain("token=setup-token");
      expect(next.state).toBe("connected");
      expect(next.errorCode).toBeUndefined();
      expect(next.error).toBeNull();
      // The new enrollment serves w2, where it was made, and w3, which used it too.
      expect(c.grants).toContain("w2:a2");
      expect(c.grants).toContain("w1:a2");
      expect(c.grants).toContain("w3:a2");
      expect((await app.status(SERVER, "w3", "me")).errorCode).toBeUndefined();
      expect((await app.summary()).needsReconnect).toBe(false);
    });
  }

  test("a refused shared connection whose workspace the person left is set up here instead", async () => {
    const c = computer({
      service: false,
      screenControl: true,
      alsoIn: ["w2"],
      left: ["w1"],
    });
    writeFileSync(join(c.home, "connections.txt"), REFUSED);
    c.readings.a1 = { online: false };
    c.readings.a2 = { online: true };
    const app = c.create();
    // w1's machines can't be read any more, but w2 still sees the problem.
    expect((await app.status(SERVER, "w2", "me")).errorCode).toBe("reconnect_required");
    const next = await app.connect("me", SERVER, "w2", { screenControl: true });
    expect(c.minted).toEqual(["w1", "w2"]);
    expect(next.state).toBe("connected");
    expect(next.errorCode).toBeUndefined();
    expect(c.grants).toEqual(["w2:a2"]);
  });

  for (const service of [true, false]) {
    const kind = service ? "an existing agent service" : "the app's own agent";
    test(`with ${kind}: removed where it was made, turning on where it was shared sets it up here`, async () => {
      const c = computer({ service, screenControl: true, alsoIn: ["w2"] });
      // Removed in w1: its enrollment is revoked there, so the agent stopped retrying.
      writeFileSync(join(c.home, "connections.txt"), REFUSED);
      c.readings.a1 = null;
      c.readings.a2 = { online: true };
      const app = c.create();
      expect((await app.status(SERVER, "w2", "me")).errorCode).toBe("removed");
      const next = await app.connect("me", SERVER, "w2", { screenControl: true });
      // Never back into w1, where it was removed on purpose.
      expect(c.minted).toEqual(["w2"]);
      expect(c.grants).toEqual(["w2:a2"]);
      expect(next.state).toBe("connected");
      expect(next.errorCode).toBeUndefined();
    });
  }

  test("removed where it was made, not yet seen here: still set up here, never back there", async () => {
    const c = computer({ service: false, screenControl: true, alsoIn: ["w2"] });
    writeFileSync(join(c.home, "connections.txt"), REFUSED);
    c.readings.a1 = null;
    c.readings.a2 = { online: true };
    const app = c.create();
    const next = await app.connect("me", SERVER, "w2", { screenControl: true });
    // The token for w1 goes unused and expires; only w2 is set up.
    expect(c.minted).toEqual(["w1", "w2"]);
    expect(c.commands().filter((command) => command.startsWith("token="))).toHaveLength(1);
    expect(c.grants).toEqual(["w2:a2"]);
    expect(next.state).toBe("connected");
  });

  test("connecting again where it was made keeps its enrollment, and every workspace keeps it", async () => {
    const c = computer({
      service: false,
      screenControl: true,
      alsoIn: ["w2", "w3"],
      keepEnrollment: true,
    });
    writeFileSync(join(c.home, "connections.txt"), REFUSED);
    c.readings.a1 = { online: false };
    const app = c.create();
    const next = await app.connect("me", SERVER, "w2", { screenControl: true });
    expect(c.minted).toEqual(["w1"]);
    expect(next.state).toBe("connected");
    expect(next.errorCode).toBeUndefined();
    // The same enrollment keeps its grants: nothing to grant again elsewhere.
    expect(c.grants).toEqual(["w2:a1"]);
    c.readings.a1 = { online: true };
    app.invalidate();
    for (const workspace of ["w2", "w3"]) {
      const status = await app.status(SERVER, workspace, "me");
      expect(status.state).toBe("connected");
      expect(status.errorCode).toBeUndefined();
    }
  });

  test("connected again where it was made but not let in here: says so, never sets it up twice", async () => {
    const c = computer({ service: false, screenControl: true, alsoIn: ["w2"] });
    writeFileSync(join(c.home, "connections.txt"), REFUSED);
    c.readings.a1 = { online: false };
    c.readings.a2 = new Error("not yours");
    const app = c.create();
    const failed = await app
      .connect("me", SERVER, "w2", { screenControl: true })
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(failed).toBeInstanceOf(ThisComputerError);
    expect((failed as Error).message).toContain("Couldn't let agents use this computer");
    expect(c.minted).toEqual(["w1"]);
  });

  test("whether it is still listed where it was made can't be read: asks to try again, changing nothing", async () => {
    const c = computer({ service: false, screenControl: true, alsoIn: ["w2"] });
    writeFileSync(join(c.home, "connections.txt"), REFUSED);
    c.readings.a1 = { status: 503, message: "unavailable" };
    const app = c.create();
    const failed = await app
      .connect("me", SERVER, "w2", { screenControl: true })
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(failed).toBeInstanceOf(ThisComputerError);
    expect(c.minted).toEqual(["w1"]);
    expect(c.commands().filter((command) => command.startsWith("token="))).toEqual([]);
    expect(c.grants).toEqual([]);
  });

  test("the menu bar says a refused connection needs reconnecting, but not while paused", async () => {
    const c = computer({ service: false });
    writeFileSync(join(c.home, "connections.txt"), REFUSED);
    const app = c.create();
    await app.boot();
    expect((await app.summary()).needsReconnect).toBe(true);
    await app.pause();
    expect((await app.summary()).needsReconnect).toBe(false);
    // Merely renewing its sign-in is still connecting, not a problem.
    writeFileSync(
      join(c.home, "connections.txt"),
      `  c1  ${SERVER}  workspace=w1  agent=a1\n` +
        "    Authentication rejected; transport retries paused while credentials are renewed.\n",
    );
    await app.resume();
    app.invalidate();
    const summary = await app.summary();
    expect(summary.needsReconnect).toBe(false);
    expect(summary.reconnecting).toBe(true);
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
  test("another account's view never takes this computer away from its owner", async () => {
    for (const service of [true, false]) {
      const c = computer({ service, ownerOnly: true });
      const app = c.create();
      // Its owner's view lists it: on.
      expect(await app.status(SERVER, "w1", "me")).toMatchObject({ state: "connected" });
      // Someone else signed in to the same workspace: not listed there, not removed.
      const other = await app.status(SERVER, "w1", "someone-else");
      expect(other.errorCode).not.toBe("removed");
      expect(other.state).not.toBe("not_connected");
      // The owner still has it, with nothing stopped or flagged.
      const mine = await app.status(SERVER, "w1", "me");
      expect(mine.state).toBe("connected");
      expect(mine.errorCode).toBeUndefined();
      expect(c.commands().filter((command) => command === "service stop")).toEqual([]);
      // Its owner's view decides: removed there, it is off.
      c.readings.a1 = null;
      app.invalidate();
      expect(await app.status(SERVER, "w1", "me")).toMatchObject({
        state: "not_connected",
        errorCode: "removed",
      });
    }
  });

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
