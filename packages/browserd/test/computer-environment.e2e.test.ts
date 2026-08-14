import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserActionCommand,
  BrowserObservation,
  ComputerAction,
  ComputerActionCommand,
  ComputerObservation,
  ComputerTarget,
  InteractionSemanticNodeValue,
} from "@opengeni/contracts";
import {
  BrowserSupervisor,
  ComputerNativeClient,
  ComputerSupervisor,
  LinuxVirtualComputerEnvironmentAllocator,
  type ComputerEnvironmentAllocator,
  type ComputerEnvironmentLease,
} from "../src";

const enabled =
  process.platform === "linux" &&
  process.env.OPENGENI_COMPUTER_ENVIRONMENT_E2E === "1" &&
  Boolean(process.env.OPENGENI_COMPUTER_NATIVE_BINARY);

test.skipIf(!enabled)(
  "isolates two live Linux ComputerSessions through X11, D-Bus, AT-SPI, input, and capture",
  async () => {
    const rootDirectory = await mkdtemp("/tmp/og-computer-environment-");
    const firstId = "11111111-1111-4111-8111-111111111111";
    const secondId = "22222222-2222-4222-8222-222222222222";
    const fixtureTitles = new Map([
      [firstId, "OpenGeni isolated fixture A"],
      [secondId, "OpenGeni isolated fixture B"],
    ]);
    const runtimeDirectories = new Map<string, string>();
    const allocator = fixtureAllocator(fixtureTitles, runtimeDirectories);
    const supervisor = await ComputerSupervisor.open({
      rootDirectory,
      nativeBinaryPath: process.env.OPENGENI_COMPUTER_NATIVE_BINARY!,
      environmentAllocator: allocator,
      maxSessions: 2,
    });
    try {
      const [first, second] = await Promise.all([
        supervisor.createSession({
          computerSessionId: firstId,
          controllerGeneration: "controller-a",
        }),
        supervisor.createSession({
          computerSessionId: secondId,
          controllerGeneration: "controller-b",
        }),
      ]);
      expect(first.displayId).not.toBe(second.displayId);
      expect(first.seatId).not.toBe(second.seatId);

      const firstTarget = await waitForTarget(
        supervisor,
        { computerSessionId: firstId, controllerGeneration: "controller-a" },
        fixtureTitles.get(firstId)!,
      );
      const secondTargets = await supervisor.listTargets({
        computerSessionId: secondId,
        controllerGeneration: "controller-b",
      });
      expect(secondTargets.some((target) => target.title === fixtureTitles.get(firstId))).toBe(
        false,
      );
      expect(secondTargets.some((target) => target.title === fixtureTitles.get(secondId))).toBe(
        true,
      );

      const observation = await supervisor.observe(
        { computerSessionId: firstId, controllerGeneration: "controller-a" },
        firstTarget.id,
      );
      const input = findNode(observation, "Fixture input");
      const receipt = await supervisor.action(
        setValueCommand(observation, input.ref, "typed through the native adapter"),
      );
      expect(receipt.state).toBe("completed");
      expect(
        receipt.observation && hasValue(receipt.observation, "typed through the native adapter"),
      ).toBe(true);

      const updatedInput = findNode(receipt.observation!, "Fixture input");
      const focused = await supervisor.action(
        semanticCommand(receipt.observation!, updatedInput.ref, "focus"),
      );
      expect(focused.state).toBe("completed");
      const screen = (await supervisor.listTargets(first)).find(
        (target) => target.kind === "screen",
      );
      if (!screen) throw new Error("isolated Linux screen target is missing");
      expect(
        (
          await supervisor.action(
            screenCommand(first, screen, {
              type: "keyboard",
              action: "press",
              value: "Control+a",
            }),
          )
        ).state,
      ).toBe("completed");
      expect(
        (
          await supervisor.action(
            screenCommand(first, screen, { type: "clipboard", operation: "copy" }),
          )
        ).state,
      ).toBe("completed");
      await waitForClipboardText(supervisor, first, "typed through the native adapter");

      const clipboardWrite = await supervisor.action(
        screenCommand(first, screen, {
          type: "clipboard",
          operation: "write",
          text: "pasted through the native clipboard Ω",
        }),
      );
      expect(clipboardWrite.state).toBe("completed");
      expect(await supervisor.clipboard(first)).toMatchObject({
        text: "pasted through the native clipboard Ω",
        truncated: false,
      });
      expect(await supervisor.clipboard(second)).toMatchObject({ text: null, truncated: false });
      expect(
        (
          await supervisor.action(
            screenCommand(first, screen, {
              type: "keyboard",
              action: "press",
              value: "Control+a",
            }),
          )
        ).state,
      ).toBe("completed");
      expect(
        (
          await supervisor.action(
            screenCommand(first, screen, { type: "clipboard", operation: "paste" }),
          )
        ).state,
      ).toBe("completed");
      await waitForValue(
        supervisor,
        first,
        firstTarget.id,
        "pasted through the native clipboard Ω",
      );
      const clipboardClear = await supervisor.action(
        screenCommand(first, screen, { type: "clipboard", operation: "clear" }),
      );
      expect(clipboardClear.state).toBe("completed");
      expect(await supervisor.clipboard(first)).toMatchObject({ text: null, truncated: false });

      const frame = await supervisor.capture(
        { computerSessionId: firstId, controllerGeneration: "controller-a" },
        firstTarget.id,
      );
      expect([...frame.data.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(frame.width).toBeGreaterThan(0);
      expect(frame.height).toBeGreaterThan(0);

      await Promise.all([
        supervisor.endSession({
          computerSessionId: firstId,
          controllerGeneration: "controller-a",
        }),
        supervisor.endSession({
          computerSessionId: secondId,
          controllerGeneration: "controller-b",
        }),
      ]);
      for (const sessionId of [firstId, secondId]) {
        const sessionDirectory = join(rootDirectory, "computer-sessions", sessionId);
        await expect(access(runtimeDirectories.get(sessionId)!)).rejects.toBeDefined();
        await expect(access(join(sessionDirectory, "gui-cache"))).rejects.toBeDefined();
        await access(join(sessionDirectory, "operations.sqlite"));
      }
    } finally {
      await supervisor.close();
      await rm(rootDirectory, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(!enabled)(
  "shares one live Linux seat clipboard across independent native helpers",
  async () => {
    const allocator = new LinuxVirtualComputerEnvironmentAllocator();
    const sessionDirectory = await mkdtemp("/tmp/og-shared-seat-");
    let lease: ComputerEnvironmentLease | null = null;
    let first: ComputerNativeClient | null = null;
    let second: ComputerNativeClient | null = null;
    try {
      lease = await allocator.allocate({
        computerSessionId: "77777777-7777-4777-8777-777777777777",
        controllerGeneration: "shared-seat-controller",
        sessionDirectory,
        baseEnvironment: process.env,
      });
      const options = {
        binaryPath: process.env.OPENGENI_COMPUTER_NATIVE_BINARY!,
        env: { ...process.env, ...lease.environment },
      };
      first = await ComputerNativeClient.open(options);
      second = await ComputerNativeClient.open(options);
      const firstScreen = (await first.targets()).find((target) => target.kind === "screen");
      const secondScreen = (await second.targets()).find((target) => target.kind === "screen");
      if (!firstScreen || !secondScreen) throw new Error("shared Linux screen target is missing");
      await first.dispatch({
        targetId: firstScreen.id,
        expectedTargetGeneration: firstScreen.targetGeneration,
        expectedObservationId: null,
        expectedFrameId: null,
        action: { type: "clipboard", operation: "write", text: "shared seat clipboard Ω" },
      });
      expect(await second.clipboard()).toEqual({
        text: "shared seat clipboard Ω",
        truncated: false,
      });
      await second.dispatch({
        targetId: secondScreen.id,
        expectedTargetGeneration: secondScreen.targetGeneration,
        expectedObservationId: null,
        expectedFrameId: null,
        action: { type: "clipboard", operation: "clear" },
      });
      expect(await first.clipboard()).toEqual({ text: null, truncated: false });
    } finally {
      await Promise.allSettled([first?.close(), second?.close()]);
      await lease?.close();
      await rm(sessionDirectory, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(!enabled)(
  "hosts one exact headed BrowserSession inside its linked Linux ComputerSession",
  async () => {
    const rootDirectory = await mkdtemp("/tmp/og-linked-browser-computer-");
    const socketDirectory = await mkdtemp("/tmp/ogls-");
    const computerReference = {
      computerSessionId: "33333333-3333-4333-8333-333333333333",
      controllerGeneration: "computer-controller",
    };
    const browserReference = {
      browserSessionId: "44444444-4444-4444-8444-444444444444",
      controllerGeneration: "browser-controller",
    };
    const computer = await ComputerSupervisor.open({
      rootDirectory: join(rootDirectory, "computer"),
      nativeBinaryPath: process.env.OPENGENI_COMPUTER_NATIVE_BINARY!,
      environmentAllocator: new LinuxVirtualComputerEnvironmentAllocator(),
      maxSessions: 1,
    });
    const browser = await BrowserSupervisor.open({
      rootDirectory: join(rootDirectory, "browser"),
      socketRootDirectory: socketDirectory,
      maxSessions: 1,
    });
    try {
      await computer.createSession(computerReference);
      const launchEnvironment = computer.launchEnvironment(computerReference);
      expect(launchEnvironment.TMPDIR).toStartWith("/tmp/ogct-");
      expect(Buffer.byteLength(launchEnvironment.TMPDIR!)).toBeLessThan(64);
      const created = await browser.createSession({
        ...browserReference,
        headed: true,
        browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE ?? "/usr/bin/chromium",
        initialUrl: browserFixture(),
        linkedComputer: computerReference,
        launchEnvironment,
      });

      const nativeBefore = await waitForTargetContaining(
        computer,
        computerReference,
        "OpenGeni linked Chromium proof",
      );
      expect(nativeBefore.kind).toBe("window");
      expect(nativeBefore.processId).not.toBeNull();
      const frameBefore = await computer.capture(computerReference, nativeBefore.id);

      const receipt = await browser.action(browserClickCommand(created.observation));
      expect(receipt.state).toBe("completed");
      expect(browserNames(receipt.observation!)).toContain("Changed through BrowserSession");

      const nativeAfter = await waitForTargetContaining(
        computer,
        computerReference,
        "OpenGeni linked Chromium proof changed",
      );
      expect(nativeAfter.id).toBe(nativeBefore.id);
      const frameAfter = await computer.capture(computerReference, nativeAfter.id);
      expect(digest(frameAfter.data)).not.toBe(digest(frameBefore.data));

      const nativeObservation = await computer.observe(computerReference, nativeAfter.id);
      expect(
        semanticNames(nativeObservation).some((name) =>
          name.includes("OpenGeni linked Chromium proof changed"),
        ),
      ).toBe(true);
      const nativePage = await waitForNativeNode(computer, computerReference, "Linked input");
      expect(nativePage.node.role).toBe("entry");
      const nativeButton = findNode(nativePage.observation, "Native change");
      const nativeClicked = await computer.action(
        semanticActionCommand(nativePage.observation, nativeButton.ref, "invoke"),
      );
      expect(nativeClicked.state).toBe("completed");
      expect(
        browserNames(await browser.selectTarget(browserReference, created.observation.target.id)),
      ).toContain("Changed through ComputerSession");

      await browser.endSession(browserReference, { removeState: true });
      await computer.endSession(computerReference, { removeState: true });
      await expect(access(launchEnvironment.TMPDIR!)).rejects.toBeDefined();
    } finally {
      await browser.close();
      await computer.close();
      await rm(rootDirectory, { recursive: true, force: true });
      await rm(socketDirectory, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(!enabled)(
  "reaps the exact agent-browser daemon after Chromium launch fails",
  async () => {
    const rootDirectory = await mkdtemp("/tmp/og-browser-failure-");
    const socketDirectory = await mkdtemp("/tmp/ogfs-");
    const longTemporaryDirectory = join(rootDirectory, "t".repeat(96));
    await mkdir(longTemporaryDirectory, { recursive: true });
    const browser = await BrowserSupervisor.open({
      rootDirectory: join(rootDirectory, "browser"),
      socketRootDirectory: socketDirectory,
      maxSessions: 1,
    });
    try {
      await expect(
        browser.createSession({
          browserSessionId: "55555555-5555-4555-8555-555555555555",
          controllerGeneration: "browser-controller-failure",
          headed: true,
          browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE ?? "/usr/bin/chromium",
          linkedComputer: {
            computerSessionId: "66666666-6666-4666-8666-666666666666",
            controllerGeneration: "computer-controller-failure",
          },
          launchEnvironment: { TMPDIR: longTemporaryDirectory },
        }),
      ).rejects.toBeDefined();
      expect(await filesEndingWith(socketDirectory, ".pid")).toEqual([]);
    } finally {
      await browser.close();
      await rm(rootDirectory, { recursive: true, force: true });
      await rm(socketDirectory, { recursive: true, force: true });
    }
  },
  60_000,
);

function fixtureAllocator(
  titles: ReadonlyMap<string, string>,
  runtimeDirectories: Map<string, string>,
): ComputerEnvironmentAllocator {
  const base = new LinuxVirtualComputerEnvironmentAllocator();
  return {
    async allocate(context) {
      const lease = await base.allocate(context);
      runtimeDirectories.set(context.computerSessionId, lease.environment.XDG_RUNTIME_DIR!);
      const title = titles.get(context.computerSessionId);
      if (!title) {
        await lease.close();
        throw new Error("fixture title is missing");
      }
      const fixture = Bun.spawn(["python3", "-c", gtkFixture(title)], {
        env: lease.environment,
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        expect(await readLine(fixture.stdout, 5_000)).toBe("READY");
      } catch (error) {
        fixture.kill("SIGKILL");
        await fixture.exited;
        await lease.close();
        throw error;
      }
      return closeWithFixture(lease, fixture);
    },
  };
}

function closeWithFixture(
  lease: ComputerEnvironmentLease,
  fixture: ReturnType<typeof Bun.spawn>,
): ComputerEnvironmentLease {
  let closed = false;
  return {
    ...lease,
    async close() {
      if (closed) return;
      closed = true;
      fixture.kill("SIGTERM");
      await Promise.race([
        fixture.exited,
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (fixture.exitCode === null) {
        fixture.kill("SIGKILL");
        await fixture.exited;
      }
      await lease.close();
    },
  };
}

async function waitForTarget(
  supervisor: ComputerSupervisor,
  reference: { computerSessionId: string; controllerGeneration: string },
  title: string,
) {
  const deadline = Date.now() + 10_000;
  do {
    const targets = await supervisor.listTargets(reference);
    const target = targets.find(
      (candidate) => candidate.kind === "window" && candidate.title === title,
    );
    if (target) return target;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`native ComputerSession never observed ${title}`);
}

async function waitForTargetContaining(
  supervisor: ComputerSupervisor,
  reference: { computerSessionId: string; controllerGeneration: string },
  title: string,
) {
  const deadline = Date.now() + 15_000;
  do {
    const targets = await supervisor.listTargets(reference);
    const target = targets.find(
      (candidate) => candidate.kind === "window" && candidate.title.includes(title),
    );
    if (target) return target;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`linked ComputerSession never observed ${title}`);
}

async function waitForNativeNode(
  supervisor: ComputerSupervisor,
  reference: { computerSessionId: string; controllerGeneration: string },
  name: string,
): Promise<{ observation: ComputerObservation; node: InteractionSemanticNodeValue }> {
  const deadline = Date.now() + 15_000;
  let observed: Array<{ title: string; kind: string; names: string[] }> = [];
  do {
    observed = [];
    for (const target of await supervisor.listTargets(reference)) {
      if (target.kind === "screen") continue;
      const observation = await supervisor.observe(reference, target.id);
      const nodes = flattenSemantic(
        observation.semantic?.kind === "snapshot" ? observation.semantic.roots : [],
      );
      const node = nodes.find((candidate) => candidate.name === name);
      if (node) return { observation, node };
      observed.push({
        title: target.title,
        kind: target.kind,
        names: nodes.flatMap((candidate) => (candidate.name ? [candidate.name] : [])).slice(0, 24),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`native ComputerSession never observed ${name}: ${JSON.stringify(observed)}`);
}

function browserFixture(): string {
  return `data:text/html,${encodeURIComponent(`<!doctype html>
    <html><head><title>OpenGeni linked Chromium proof</title></head><body>
      <button onclick="document.title='OpenGeni linked Chromium proof changed'; document.body.style.background='#36c'; this.textContent='Changed through BrowserSession'">Change page</button>
      <label>Linked input <input aria-label="Linked input" /></label>
      <button aria-label="Native change" onclick="this.textContent='Changed through ComputerSession'; this.setAttribute('aria-label', 'Changed through ComputerSession')">Native change</button>
    </body></html>`)}`;
}

function browserClickCommand(observation: BrowserObservation): BrowserActionCommand {
  const button = flattenSemantic(
    observation.semantic?.kind === "snapshot" ? observation.semantic.roots : [],
  ).find((node) => node.role === "button");
  if (!button) throw new Error("linked browser fixture button is missing");
  return {
    protocolVersion: 1,
    operationId: randomUUID(),
    browserSessionId: observation.browserSessionId,
    controllerGeneration: observation.target.controllerGeneration,
    targetId: observation.target.id,
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedDocumentGeneration: observation.target.documentGeneration,
    expectedFrameId: observation.frameId,
    actor: { kind: "agent", subjectId: "agent:linked-browser-computer-e2e" },
    action: { type: "click", locator: { kind: "ref", ref: button.ref } },
  };
}

function browserNames(observation: BrowserObservation): string[] {
  return flattenSemantic(
    observation.semantic?.kind === "snapshot" ? observation.semantic.roots : [],
  )
    .map((node) => node.name)
    .filter((name): name is string => typeof name === "string");
}

function semanticNames(observation: ComputerObservation): string[] {
  return flattenSemantic(
    observation.semantic?.kind === "snapshot" ? observation.semantic.roots : [],
  )
    .map((node) => node.name)
    .filter((name): name is string => typeof name === "string");
}

function flattenSemantic(
  nodes: readonly InteractionSemanticNodeValue[],
): InteractionSemanticNodeValue[] {
  return nodes.flatMap((node) => [node, ...flattenSemantic(node.children ?? [])]);
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function filesEndingWith(root: string, suffix: string): Promise<string[]> {
  const matches: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(suffix)) matches.push(path);
    }
  }
  return matches.sort();
}

function findNode(observation: ComputerObservation, name: string): InteractionSemanticNodeValue {
  if (!observation.semantic || observation.semantic.kind !== "snapshot") {
    throw new Error("ComputerSession returned no semantic snapshot");
  }
  const pending = [...observation.semantic.roots];
  while (pending.length > 0) {
    const node = pending.shift()!;
    if (node.name === name) return node;
    pending.unshift(...(node.children ?? []));
  }
  throw new Error(
    `semantic node ${name} is missing; available nodes: ${JSON.stringify(
      flattenSemantic(observation.semantic.roots).map((node) => ({
        role: node.role,
        name: node.name,
        value: node.value,
        actions: node.actions,
      })),
    )}`,
  );
}

function hasValue(observation: ComputerObservation, value: string): boolean {
  if (!observation.semantic || observation.semantic.kind !== "snapshot") return false;
  const pending = [...observation.semantic.roots];
  while (pending.length > 0) {
    const node = pending.shift()!;
    if (node.value === value) return true;
    pending.unshift(...(node.children ?? []));
  }
  return false;
}

function setValueCommand(
  observation: ComputerObservation,
  ref: string,
  value: string,
): ComputerActionCommand {
  return {
    protocolVersion: 1,
    operationId: randomUUID(),
    computerSessionId: observation.computerSessionId,
    controllerGeneration: observation.target.controllerGeneration,
    targetId: observation.target.id,
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedObservationId: observation.observationId,
    expectedFrameId: null,
    actor: { kind: "agent", subjectId: "agent:linux-e2e" },
    action: {
      type: "semantic",
      locator: { kind: "ref", ref },
      action: "set_value",
      value,
    },
  };
}

function semanticCommand(
  observation: ComputerObservation,
  ref: string,
  action: "focus",
): ComputerActionCommand {
  return {
    protocolVersion: 1,
    operationId: randomUUID(),
    computerSessionId: observation.computerSessionId,
    controllerGeneration: observation.target.controllerGeneration,
    targetId: observation.target.id,
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedObservationId: observation.observationId,
    expectedFrameId: null,
    actor: { kind: "agent", subjectId: "agent:linux-e2e" },
    action: { type: "semantic", locator: { kind: "ref", ref }, action },
  };
}

function semanticActionCommand(
  observation: ComputerObservation,
  ref: string,
  action: "invoke",
): ComputerActionCommand {
  return {
    protocolVersion: 1,
    operationId: randomUUID(),
    computerSessionId: observation.computerSessionId,
    controllerGeneration: observation.target.controllerGeneration,
    targetId: observation.target.id,
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedObservationId: observation.observationId,
    expectedFrameId: null,
    actor: { kind: "agent", subjectId: "agent:linux-e2e" },
    action: { type: "semantic", locator: { kind: "ref", ref }, action },
  };
}

function screenCommand(
  reference: { computerSessionId: string; controllerGeneration: string },
  target: ComputerTarget,
  action: ComputerAction,
): ComputerActionCommand {
  return {
    protocolVersion: 1,
    operationId: randomUUID(),
    computerSessionId: reference.computerSessionId,
    controllerGeneration: reference.controllerGeneration,
    targetId: target.id,
    expectedTargetGeneration: target.targetGeneration,
    expectedObservationId: null,
    expectedFrameId: null,
    actor: { kind: "agent", subjectId: "agent:linux-e2e" },
    action,
  };
}

async function waitForClipboardText(
  supervisor: ComputerSupervisor,
  reference: { computerSessionId: string; controllerGeneration: string },
  text: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  do {
    if ((await supervisor.clipboard(reference)).text === text) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`native clipboard never contained ${text}`);
}

async function waitForValue(
  supervisor: ComputerSupervisor,
  reference: { computerSessionId: string; controllerGeneration: string },
  targetId: string,
  value: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  do {
    const observation = await supervisor.observe(reference, targetId);
    if (hasValue(observation, value)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`native target never contained ${value}`);
}

function gtkFixture(title: string): string {
  return `
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk

window = Gtk.Window(title=${JSON.stringify(title)})
window.set_default_size(420, 180)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
window.add(box)
entry = Gtk.Entry()
entry.get_accessible().set_name('Fixture input')
box.pack_start(entry, True, True, 0)
window.connect('destroy', Gtk.main_quit)
window.show_all()
print('READY', flush=True)
Gtk.main()
`;
}

async function readLine(stream: ReadableStream<Uint8Array>, timeoutMs: number): Promise<string> {
  const reader = stream.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        let buffered = Buffer.alloc(0);
        while (buffered.byteLength <= 4_096) {
          const next = await reader.read();
          if (next.done) break;
          buffered = Buffer.concat([buffered, next.value]);
          const newline = buffered.indexOf(0x0a);
          if (newline >= 0) return buffered.subarray(0, newline).toString("utf8").trim();
        }
        throw new Error("fixture readiness line is missing or too large");
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("fixture did not become ready")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    await reader.cancel();
    reader.releaseLock();
  }
}
