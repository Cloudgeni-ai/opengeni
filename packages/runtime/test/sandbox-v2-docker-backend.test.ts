import { describe, expect, test } from "bun:test";
import { DockerMachineBackend, type DockerMachineDisk } from "../src/sandbox/v2/docker-backend";
import {
  MachineController,
  newMachine,
  type MachineBackend,
  type MachineDemand,
  type MachineRecord,
  type MachineScope,
  type MachineStore,
} from "../src/sandbox/v2/machine-controller";
import { MachineJournalClient } from "../src/sandbox/v2/journal-client";
import type { JournalCommand, JournalStartRequest } from "../src/sandbox/v2/journal-protocol";

class Store implements MachineStore {
  constructor(public row: MachineRecord) {}
  async load(_scope: MachineScope) {
    return structuredClone(this.row);
  }
  async compareAndSet(previous: MachineRecord, next: MachineRecord) {
    if (previous.version !== this.row.version) return false;
    this.row = structuredClone(next);
    return true;
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("Docker machine configuration", () => {
  test("a retained instance cannot redirect lifecycle mutations to another container or disk", async () => {
    const image = `sha256:${"a".repeat(64)}`;
    const backend = new DockerMachineBackend({ image });
    let requests = 0;
    Reflect.set(backend, "request", async () => {
      requests += 1;
      throw Error("Invalid identity must fail before provider I/O");
    });
    const scope = { workspaceId: crypto.randomUUID(), sandboxGroupId: crypto.randomUUID() };
    const machine = newMachine(scope, "docker");
    const disk: DockerMachineDisk = {
      kind: "docker-machine-v1",
      containerId: "a".repeat(64),
      volumeName: `opengeni-v2-workspace-${machine.id}`,
      image,
      createTransitionId: crypto.randomUUID(),
      diskLineage: machine.id,
      definitionDigest: "b".repeat(64),
    };
    const instance = {
      id: disk.containerId,
      bootId: "c".repeat(64),
      diskLineage: disk.diskLineage,
    };
    for (const invalid of [
      { ...instance, id: "d".repeat(64) },
      { ...instance, diskLineage: crypto.randomUUID() },
      null,
    ]) {
      const transition = {
        id: crypto.randomUUID(),
        kind: "suspend" as const,
        phase: "dispatched" as const,
        before: { state: "running" as const, instance: invalid, disk },
      };
      const retained: MachineRecord = {
        ...machine,
        state: "running",
        target: "suspended",
        instance: invalid,
        disk,
        transition,
      };
      await expect(backend.dispatch(retained, transition)).rejects.toThrow(
        "retained disk or instance",
      );
      await expect(backend.reconcile(retained, transition)).rejects.toThrow(
        "retained disk or instance",
      );
    }
    expect(requests).toBe(0);
  });
  test("mutable image tags and invalid limits cannot admit a native lifecycle request", () => {
    expect(() => new DockerMachineBackend({ image: "synthetic:latest" })).toThrow("pinned");
    const image = `sha256:${"a".repeat(64)}`;
    for (const options of [
      { memoryLimitBytes: 1 },
      { cpuLimit: NaN },
      { cpuLimit: 0 },
      { timeoutMs: Infinity },
      { socketPath: "relative.sock" },
    ])
      expect(() => new DockerMachineBackend({ image, ...options })).toThrow("pinned");
    for (const networkMode of ["host", "container:synthetic", "arbitrary", ""])
      expect(
        () =>
          new DockerMachineBackend({
            image,
            networkMode: networkMode as "bridge",
          }),
      ).toThrow("pinned");
  });
});

const fixtureImage = process.env.JOURNAL_CONFORMANCE_IMAGE;
(fixtureImage ? test : test.skip)(
  "real Linux: cold create, lost reply and delayed pause retain one machine and disk",
  async () => {
    const inspect = Bun.spawn(
      ["docker", "image", "inspect", "--format", "{{.Id}}", fixtureImage!],
      {
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    const image = (await new Response(inspect.stdout).text()).trim();
    expect(await inspect.exited).toBe(0);
    const scope = {
      workspaceId: crypto.randomUUID(),
      sandboxGroupId: crypto.randomUUID(),
    };
    const store = new Store(newMachine(scope, "docker"));
    const native = new DockerMachineBackend({
      image,
      memoryLimitBytes: 256 * 1024 ** 2,
      cpuLimit: 0.5,
      networkMode: "none",
    });
    const calls: string[] = [];
    const paused = deferred<void>();
    const pauseReply = deferred<void>();
    const backend: MachineBackend = {
      provider: "docker",
      prepareTransition: (machine, kind) => native.prepareTransition(machine, kind),
      async dispatch(machine, transition) {
        calls.push(transition.kind);
        const result = await native.dispatch(machine, transition);
        if (transition.kind === "create") throw Error("synthetic lost creation reply");
        if (transition.kind === "suspend") {
          paused.resolve();
          await pauseReply.promise;
        }
        return result;
      },
      reconcile: (machine, transition) => native.reconcile(machine, transition),
    };
    const demand: MachineDemand = {
      id: crypto.randomUUID(),
      owner: "synthetic-session",
      kind: "attempt",
      authority: "synthetic-attempt",
    };
    const nextDemand = {
      ...demand,
      id: crypto.randomUUID(),
      authority: "next-synthetic-attempt",
    };
    const controller = new MachineController(store, backend, 0);
    const referenceHolder = `opengeni-v2-ref-test-${crypto.randomUUID()}`;
    let disk: DockerMachineDisk | null = null;
    let dispatcher: Promise<MachineRecord> | null = null;
    try {
      await controller.acquire(scope, demand);
      const unknown = await controller.step(scope);
      expect(unknown.transition?.phase).toBe("unknown");
      expect(unknown.state).toBe("absent");
      expect(unknown.transition?.definition).toEqual(native.prepareTransition(unknown, "create"));
      // A replacement coordinator discovers the one stopped creation; it sends
      // neither another create nor a speculative start while the outcome is unknown.
      // Its new defaults must not rewrite the admitted image/resource definition.
      const changedDefaults = new DockerMachineBackend({
        image: `sha256:${"a".repeat(64)}`,
        memoryLimitBytes: 512 * 1024 ** 2,
        cpuLimit: 1,
        networkMode: "bridge",
      });
      const created = await new MachineController(store, changedDefaults, 0).step(scope);
      expect(created.state).toBe("suspended");
      expect(created.instance).toBeNull();
      disk = created.disk as DockerMachineDisk;
      expect(disk.image).toBe(image);
      const replacement = new MachineController(store, backend, 0);
      const running = await replacement.step(scope);
      expect(running.state).toBe("running");
      expect(running.instance?.id).toBe(disk.containerId);
      const instance = running.instance!;
      const authority = {
        async reserve(command: JournalCommand) {
          return command;
        },
        async assert() {},
      };
      const journal = new MachineJournalClient(
        { machineId: running.id, instance },
        native.transport,
        authority,
        { attempts: 1 },
      );
      const start = (cmd: string): JournalStartRequest => ({
        operationId: crypto.randomUUID(),
        bootId: instance.bootId,
        diskLineage: instance.diskLineage,
        program: "/bin/sh",
        args: ["-c", cmd],
        cwd: "/workspace",
        environment: {},
        stdin: false,
        pty: null,
      });
      const write = await journal.start(
        start("printf x >> effect; printf ram > /dev/shm/synthetic-marker"),
      );
      const completed = async (command: JournalCommand) => {
        const until = performance.now() + 5_000;
        for (;;) {
          const observed = await journal.read(command, {
            stdout: 0,
            stderr: 0,
          });
          if (observed.state === "exited") return observed;
          if (performance.now() > until) throw Error("Synthetic Docker command did not settle");
          await Bun.sleep(10);
        }
      };
      const terminal = await completed(write.command);
      expect(terminal.receipt?.leaderExitCode).toBe(0);
      await replacement.release(scope, demand);
      dispatcher = replacement.step(scope);
      await Promise.race([
        paused.promise,
        Bun.sleep(5_000).then(() => {
          throw Error("Pause barrier timed out");
        }),
      ]);
      await replacement.acquire(scope, nextDemand);
      // Docker already completed its pause, but delivery of that reply is held.
      // Another coordinator can prove that exact completed transition, then wake.
      expect((await controller.step(scope)).state).toBe("suspended");
      const awake = await controller.step(scope);
      expect(awake.state).toBe("running");
      expect(awake.instance).toEqual(instance);
      pauseReply.resolve();
      expect((await dispatcher).state).toBe("running");
      expect(store.row.instance).toEqual(instance);
      expect(calls).toEqual(["create", "resume", "suspend", "resume"]);
      const read = await journal.start(start("cat effect /dev/shm/synthetic-marker"));
      const result = await completed(read.command);
      expect(Buffer.from(result.stdout.data, "base64").toString()).toBe("xram");
      expect((await journal.read(write.command, { stdout: 0, stderr: 0 })).receipt).toEqual(
        terminal.receipt,
      );
      await controller.release(scope, nextDemand);
      await controller.requestDestroy(scope);
      // Simulate the daemon's gap between CID disappearance and volume-reference
      // release using one stopped, exactly owned fixture holding that same disk.
      const holdReference = Bun.spawn(
        [
          "docker",
          "create",
          "--name",
          referenceHolder,
          "--mount",
          `type=volume,source=${disk.volumeName},target=/workspace`,
          image,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      expect(await holdReference.exited).toBe(0);
      const deletes: string[] = [];
      // Lose replies at the actual request boundary, between resource mutations.
      // A whole-dispatch wrapper would miss the container/volume crash window.
      const request = Reflect.get(native, "request").bind(native) as (
        method: string,
        path: string,
        body?: unknown,
      ) => Promise<Response>;
      Reflect.set(native, "request", async (method: string, path: string, body?: unknown) => {
        const response = await request(method, path, body);
        if (method === "DELETE") {
          deletes.push(path);
          if (response.status === 204) throw Error("Synthetic lost resource-delete reply");
        }
        return response;
      });
      expect((await controller.step(scope)).transition?.phase).toBe("unknown");
      expect(deletes).toEqual([`/containers/${disk.containerId}?force=true`]);
      expect((await controller.step(scope)).state).toBe("destroying");
      expect(deletes).toHaveLength(1);
      await expect(controller.acquire(scope, demand)).rejects.toThrow("deletion");
      const cleanupReplacement = new MachineController(store, backend, 0);
      const refused = await cleanupReplacement.step(scope);
      expect(refused.state).toBe("destroying");
      expect(refused.transition).toBeNull();
      expect(deletes).toEqual([
        `/containers/${disk.containerId}?force=true`,
        `/volumes/${disk.volumeName}`,
      ]);
      const releaseReference = Bun.spawn(["docker", "rm", referenceHolder], {
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await releaseReference.exited).toBe(0);
      const volumeUnknown = await cleanupReplacement.step(scope);
      expect(volumeUnknown.state).toBe("destroying");
      expect(volumeUnknown.transition?.phase).toBe("unknown");
      expect(deletes).toEqual([
        `/containers/${disk.containerId}?force=true`,
        `/volumes/${disk.volumeName}`,
        `/volumes/${disk.volumeName}`,
      ]);
      expect((await controller.step(scope)).state).toBe("destroyed");
      expect(deletes).toHaveLength(3);
      const absent = await fetch(`http://localhost/v1.51/containers/${disk.containerId}/json`, {
        unix: "/var/run/docker.sock",
      });
      expect(absent.status).toBe(404);
      const volume = await fetch(`http://localhost/v1.51/volumes/${disk.volumeName}`, {
        unix: "/var/run/docker.sock",
      });
      expect(volume.status).toBe(404);
    } finally {
      pauseReply.resolve();
      await dispatcher?.catch(() => undefined);
      const releaseReference = Bun.spawn(["docker", "rm", "-f", referenceHolder], {
        stdout: "ignore",
        stderr: "ignore",
      });
      await releaseReference.exited;
      // Cleanup addresses only this generated machine. No shared fixture prune.
      const exact = disk?.containerId ?? `opengeni-v2-${store.row.id}`;
      const remove = Bun.spawn(["docker", "rm", "-f", exact], {
        stdout: "ignore",
        stderr: "ignore",
      });
      await remove.exited;
      const removeVolume = Bun.spawn(
        ["docker", "volume", "rm", `opengeni-v2-workspace-${store.row.id}`],
        { stdout: "ignore", stderr: "ignore" },
      );
      await removeVolume.exited;
    }
  },
  60_000,
);
