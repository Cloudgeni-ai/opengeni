import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ComputerAction,
  ComputerActionCommand,
  ComputerObservation,
} from "@opengeni/contracts";
import { ComputerSupervisor } from "../src/computer-supervisor";
import { createCuaComputerDriver } from "../src/cua/factory";

// Opt-in: creates only a disposable background AppKit window. Existing OS
// permissions must already be granted to the launching host; no prompts here.
test.skipIf(process.platform !== "darwin" || process.env.OPENGENI_CUA_E2E !== "1")(
  "CUA drives a real window through OpenGeni receipts and viewer streaming",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-cua-e2e-"));
    let fixturePid: number | undefined;
    let supervisor: ComputerSupervisor | undefined;
    const reference = { computerSessionId: randomUUID(), controllerGeneration: randomUUID() };
    type State = { pid: number; windowId: number; value: string; clicks: number };
    const actual = async (): Promise<State> =>
      await Bun.file(join(root, "fixture-state.json")).json();
    try {
      const app = join(root, "Fixture.app"),
        contents = join(app, "Contents");
      await mkdir(join(contents, "MacOS"), { recursive: true });
      await Bun.write(
        join(contents, "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>ai.opengeni.cua-fixture</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleName</key><string>OpenGeni CUA Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`,
      );
      const compiler = Bun.spawn(
        [
          "swiftc",
          join(import.meta.dir, "fixtures/cua/Fixture.swift"),
          "-o",
          join(contents, "MacOS/Fixture"),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const compilerError = await new Response(compiler.stderr).text();
      if ((await compiler.exited) !== 0) throw new Error(compilerError);
      const launch = Bun.spawn(["open", "-g", "-n", app, "--args", root]);
      expect(await launch.exited).toBe(0);
      for (let i = 0; i < 100 && !(await Bun.file(join(root, "fixture-state.json")).exists()); i++)
        await Bun.sleep(100);
      fixturePid = (await actual()).pid;
      await Bun.sleep(1000);
      supervisor = await ComputerSupervisor.open({
        rootDirectory: join(root, "controller"),
        displaceExistingSessions: true,
        createDriver: createCuaComputerDriver,
      });
      const session = await supervisor.createSession(reference);
      expect(session.adapter).toBe("opengeni.cua.macos.v1");
      const windowId = (await actual()).windowId;
      const target = session.targets.find(
        (entry) => entry.id === `cua:window:${fixturePid}:${windowId}`,
      )!;
      expect(target).toBeDefined();
      let observed = await supervisor.observe(reference, target.id);
      expect(JSON.stringify(observed)).not.toContain("fixture-secret-never-observe");
      const makeCommand = (
        source: ComputerObservation,
        action: ComputerAction,
      ): ComputerActionCommand => ({
        protocolVersion: 1,
        operationId: randomUUID(),
        ...reference,
        targetId: target.id,
        expectedTargetGeneration: source.target.targetGeneration,
        expectedObservationId: source.observationId,
        expectedFrameId: null,
        actor: { kind: "agent", subjectId: "agent:cua-fixture" },
        action,
      });
      const replacement = "Replacement æøå 🦊";
      const replace = makeCommand(observed, {
        type: "semantic",
        locator: { kind: "label", text: "Fixture text", exact: true },
        action: "set_value",
        value: replacement,
      });
      expect(await supervisor.action(replace)).toMatchObject({ state: "completed" });
      await Bun.sleep(100);
      expect((await actual()).value).toBe(replacement);
      observed = await supervisor.observe(reference, target.id);
      const invoke = makeCommand(observed, {
        type: "semantic",
        locator: { kind: "label", text: "Increment", exact: true },
        action: "invoke",
      });
      expect(await supervisor.action(invoke)).toMatchObject({ state: "completed" });
      expect(await supervisor.action(invoke)).toMatchObject({ state: "completed" });
      await Bun.sleep(100);
      expect((await actual()).clicks).toBe(1); // Durable replay must not click twice.
      const stream = await supervisor.subscribeFrames(reference, target.id, {
        maxWidth: 480,
        maxHeight: 300,
        format: "png",
      });
      try {
        const first = await stream[Symbol.asyncIterator]().next();
        expect(first.done).toBe(false);
        expect(first.value!.mediaType).toBe("image/png");
        expect(first.value!.data.byteLength).toBeGreaterThan(100);
        observed = await supervisor.observe(reference, target.id);
        await Bun.sleep(1000);
        const liveReplace = makeCommand(observed, {
          type: "semantic",
          locator: { kind: "label", text: "Fixture text", exact: true },
          action: "set_value",
          value: "Viewer open",
        });
        // SDK 0.30.4 capture-only reads invalidate element handles. Keep this
        // limitation explicit until upstream provides non-invalidating previews.
        expect(await supervisor.action(liveReplace)).toMatchObject({
          state: "failed",
          error: { code: "observation_stale" },
        });
        observed = await supervisor.observe(reference, target.id);
        const frame = await supervisor.capture(reference, target.id, {
          maxWidth: 480,
          maxHeight: 300,
          format: "png",
        });
        const semantic = observed.semantic;
        if (semantic?.kind !== "snapshot") throw new Error("Fixture needs a full snapshot");
        const button = semantic.roots.find((node) => node.name === "Increment")!.bounds!;
        const bounds = observed.target.bounds!;
        const click = makeCommand(observed, {
          type: "pointer",
          action: "click",
          frameId: frame.frameId,
          x: ((button.x - bounds.x + button.width / 2) * frame.width) / bounds.width,
          y: ((button.y - bounds.y + button.height / 2) * frame.height) / bounds.height,
        });
        click.expectedFrameId = frame.frameId;
        expect(await supervisor.action(click)).toMatchObject({ state: "completed" });
        await Bun.sleep(100);
        expect((await actual()).clicks).toBe(2);
        const gesture = (action: ComputerAction): ComputerActionCommand => ({
          ...makeCommand(observed, action),
          expectedFrameId: frame.frameId,
        });
        const x = (560 * frame.width) / bounds.width;
        const y = ((bounds.height - 140) * frame.height) / bounds.height;
        for (let index = 0; index < 2; index++) {
          expect(
            await supervisor.action(
              gesture({
                type: "pointer",
                action: "scroll",
                frameId: frame.frameId,
                x,
                y,
                deltaY: 200,
              }),
            ),
          ).toMatchObject({ state: "completed" });
          // SDK 0.30.4 requires foreground delivery for Mac drag. The pilot must
          // report that limitation, not steal focus or claim it delivered input.
          expect(
            await supervisor.action(
              gesture({
                type: "pointer",
                action: "drag",
                frameId: frame.frameId,
                x,
                y,
                endX: x + 20,
                endY: y + 20,
              }),
            ),
          ).toMatchObject({ state: "failed", error: { code: "unsupported" } });
        }
        await Bun.sleep(100);
        expect(((await actual()) as State & { scrollEvents: number }).scrollEvents).toBeGreaterThan(
          0,
        );
        expect(((await actual()) as State & { dragEvents: number }).dragEvents).toBe(0);
      } finally {
        await stream.close();
      }
    } finally {
      await supervisor?.close();
      if (fixturePid) {
        try {
          process.kill(fixturePid, "SIGTERM");
        } catch {}
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
