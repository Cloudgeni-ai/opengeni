import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { JournalCapabilities } from "./journal-protocol";
import { DockerMachineExecTransport } from "./docker-transport";
import {
  MachineConflictError,
  type MachineBackend,
  type MachineLifecycleOptions,
  type MachineRecord,
  type MachineTransition,
  type TransitionResult,
} from "./machine-controller";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const containerId = /^[0-9a-f]{64}$/u;
const image = /^(?:sha256:[0-9a-f]{64}|[^\s@]+@sha256:[0-9a-f]{64})$/u;
const label = {
  machine: "io.opengeni.sandbox-v2.machine",
  create: "io.opengeni.sandbox-v2.create",
  lineage: "io.opengeni.sandbox-v2.lineage",
  definition: "io.opengeni.sandbox-v2.definition",
};
const DockerCreateDefinition = z
  .object({
    kind: z.literal("docker-create-v1"),
    config: z
      .object({
        Image: z.string().regex(image),
        Entrypoint: z.tuple([z.literal("/bin/sh")]),
        Cmd: z.tuple([z.literal("-c"), z.literal("exec sleep infinity")]),
        WorkingDir: z.literal("/workspace"),
        HostConfig: z
          .object({
            Init: z.literal(true),
            AutoRemove: z.literal(false),
            RestartPolicy: z.object({ Name: z.literal("no") }).strict(),
            NetworkMode: z.enum(["bridge", "none"]),
            Memory: z
              .number()
              .int()
              .min(256 * 1024 ** 2)
              .max(64 * 1024 ** 3),
            NanoCpus: z
              .number()
              .int()
              .min(0)
              .max(64 * 1e9)
              .refine((value) => value === 0 || value >= 0.1 * 1e9),
            ShmSize: z.literal(128 * 1024 ** 2),
            CapDrop: z.tuple([z.literal("ALL")]),
            SecurityOpt: z.tuple([z.literal("no-new-privileges")]),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
const DockerDisk = z
  .object({
    kind: z.literal("docker-machine-v1"),
    containerId: z.string().regex(containerId),
    volumeName: z.string(),
    image: z.string().regex(image),
    createTransitionId: z.string().regex(uuid),
    diskLineage: z.string().regex(uuid),
    definitionDigest: z.string().regex(containerId),
  })
  .strict();
export type DockerMachineDisk = z.infer<typeof DockerDisk>;
const Container = z.object({
  Id: z.string().regex(containerId),
  Name: z.string(),
  Config: z.object({
    Image: z.string(),
    Labels: z.record(z.string(), z.string()),
  }),
  State: z.object({
    Status: z.string(),
    Running: z.boolean(),
    Paused: z.boolean(),
    Restarting: z.boolean(),
    Dead: z.boolean(),
  }),
  HostConfig: z.object({ RestartPolicy: z.object({ Name: z.string() }) }),
  Mounts: z.array(
    z.object({
      Type: z.string(),
      Name: z.string().optional(),
      Destination: z.string(),
      RW: z.boolean(),
    }),
  ),
});
const Volume = z.object({
  Name: z.string(),
  Driver: z.literal("local"),
  Scope: z.literal("local"),
  Options: z.object({}).strict().nullable(),
  Labels: z.record(z.string(), z.string()),
});
type Container = z.infer<typeof Container>;

export type DockerMachineBackendOptions = {
  /** Resolve/pull before admission. A tag cannot select an existing machine. */
  image: string;
  socketPath?: string;
  timeoutMs?: number;
  memoryLimitBytes?: number;
  cpuLimit?: number;
  networkMode?: "bridge" | "none";
};

/** One Linux Docker daemon, exclusively controlled for these generated names.
 * Creation allocates a stopped container; waking is a separate transition.
 * No restart policy, checkpoint, replacement container or RPC redispatch.
 *
 * Reconciliation uses immutable identity plus a change from the recorded
 * before-state. Docker start/pause/unpause and inspect share the container
 * mutex: a changed inspect cannot precede completion of that one mutation.
 * Generic status without this backend-specific ordering is not such proof.
 * A dispatched request that never reached Docker can remain unknown.
 */
export class DockerMachineBackend implements MachineBackend {
  readonly provider = "docker";
  readonly transport: DockerMachineExecTransport;
  private readonly operationSignal = new AsyncLocalStorage<AbortSignal | undefined>();
  private readonly options: Required<Omit<DockerMachineBackendOptions, "cpuLimit">> & {
    cpuLimit: number | null;
  };
  constructor(options: DockerMachineBackendOptions) {
    this.options = {
      image: options.image,
      socketPath: options.socketPath ?? "/var/run/docker.sock",
      timeoutMs: options.timeoutMs ?? 30_000,
      memoryLimitBytes: options.memoryLimitBytes ?? 8 * 1024 ** 3,
      cpuLimit: options.cpuLimit ?? null,
      networkMode: options.networkMode ?? "bridge",
    };
    if (
      (this.options.networkMode !== "bridge" && this.options.networkMode !== "none") ||
      !image.test(this.options.image) ||
      !this.options.socketPath.startsWith("/") ||
      this.options.socketPath.includes("\0") ||
      !Number.isSafeInteger(this.options.timeoutMs) ||
      this.options.timeoutMs < 1_000 ||
      this.options.timeoutMs > 60_000 ||
      !Number.isSafeInteger(this.options.memoryLimitBytes) ||
      this.options.memoryLimitBytes < 256 * 1024 ** 2 ||
      this.options.memoryLimitBytes > 64 * 1024 ** 3 ||
      (this.options.cpuLimit !== null &&
        (!Number.isFinite(this.options.cpuLimit) ||
          this.options.cpuLimit < 0.1 ||
          this.options.cpuLimit > 64))
    )
      throw new MachineConflictError("Invalid pinned Docker machine configuration");
    this.transport = new DockerMachineExecTransport(
      this.options.timeoutMs,
      this.options.socketPath,
    );
  }

  private name(machine: MachineRecord) {
    return `opengeni-v2-${machine.id}`;
  }
  private volumeName(machine: MachineRecord) {
    return `opengeni-v2-workspace-${machine.id}`;
  }
  private assertTransition(machine: MachineRecord, transition: MachineTransition) {
    if (
      machine.provider !== this.provider ||
      !uuid.test(machine.id) ||
      !uuid.test(transition.id) ||
      !isDeepStrictEqual(machine.transition, transition) ||
      machine.state !== transition.before.state ||
      !isDeepStrictEqual(machine.instance, transition.before.instance) ||
      !isDeepStrictEqual(machine.disk, transition.before.disk) ||
      transition.phase === "reserved"
    )
      throw new MachineConflictError("Docker transition lacks exact durable admission");
    if (transition.kind === "destroy" && (machine.demands.length || machine.target !== "destroyed"))
      throw new MachineConflictError("Docker destruction still has live demand");
    if (
      transition.kind === "create" &&
      (transition.before.state !== "absent" ||
        transition.before.disk !== null ||
        transition.before.instance !== null)
    )
      throw new MachineConflictError("Docker creation requires a fresh machine");
  }
  private async request(method: "GET" | "POST" | "DELETE", path: string, body?: unknown) {
    const signal = this.operationSignal.getStore();
    signal?.throwIfAborted();
    // There is one request, with no automatic retries or redirects. A timeout
    // does not establish that its daemon-side mutation stopped.
    return fetch(`http://localhost/v1.51${path}`, {
      unix: this.options.socketPath,
      method,
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)])
        : AbortSignal.timeout(this.options.timeoutMs),
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
  }
  private async inspectContainer(id: string): Promise<Container | null> {
    const response = await this.request("GET", `/containers/${id}/json`);
    if (response.status === 404) return null;
    if (!response.ok) throw new MachineConflictError("Docker identity inspection unavailable");
    return Container.parse(await response.json());
  }
  private async inspectVolume(name: string) {
    const response = await this.request("GET", `/volumes/${name}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new MachineConflictError("Docker disk inspection unavailable");
    return Volume.parse(await response.json());
  }
  private labels(machine: MachineRecord, disk: DockerMachineDisk) {
    return {
      [label.machine]: machine.id,
      [label.create]: disk.createTransitionId,
      [label.lineage]: disk.diskLineage,
      [label.definition]: disk.definitionDigest,
    };
  }
  private async validateContainer(
    machine: MachineRecord,
    disk: DockerMachineDisk,
    found: Container,
  ) {
    const expected = this.labels(machine, disk);
    if (
      found.Id !== disk.containerId ||
      found.Name !== `/${this.name(machine)}` ||
      found.Config.Image !== disk.image ||
      found.HostConfig.RestartPolicy.Name !== "no" ||
      Object.entries(expected).some(([key, value]) => found.Config.Labels[key] !== value) ||
      disk.volumeName !== this.volumeName(machine) ||
      disk.diskLineage !== machine.id ||
      !found.Mounts.some(
        (mount) =>
          mount.Type === "volume" &&
          mount.Name === disk.volumeName &&
          mount.Destination === "/workspace" &&
          mount.RW,
      )
    )
      throw new MachineConflictError("Docker machine or disk identity changed");
    if (!(await this.validateVolume(machine, disk)))
      throw new MachineConflictError("Docker workspace volume ownership changed");
  }
  private async validateVolume(machine: MachineRecord, disk: DockerMachineDisk) {
    const volume = await this.inspectVolume(disk.volumeName);
    if (!volume) return null;
    const expected = this.labels(machine, disk);
    if (
      volume.Name !== disk.volumeName ||
      Object.entries(expected).some(([key, value]) => volume.Labels[key] !== value)
    )
      throw new MachineConflictError("Docker workspace volume ownership changed");
    return volume;
  }
  private disk(machine: MachineRecord, transition: MachineTransition) {
    const disk = DockerDisk.parse(transition.before.disk);
    if (
      disk.volumeName !== this.volumeName(machine) ||
      disk.diskLineage !== machine.id ||
      (transition.before.instance !== null &&
        (transition.before.instance.id !== disk.containerId ||
          transition.before.instance.diskLineage !== disk.diskLineage)) ||
      (transition.before.state === "running" && transition.before.instance === null) ||
      (transition.before.state === "destroying" && transition.before.instance !== null)
    )
      throw new MachineConflictError("Docker retained disk or instance belongs to another machine");
    return disk;
  }
  prepareTransition(_machine: MachineRecord, kind: MachineTransition["kind"]) {
    if (kind !== "create") return undefined;
    return DockerCreateDefinition.parse({
      kind: "docker-create-v1",
      config: {
        Image: this.options.image,
        Entrypoint: ["/bin/sh"],
        Cmd: ["-c", "exec sleep infinity"],
        WorkingDir: "/workspace",
        HostConfig: {
          Init: true,
          AutoRemove: false,
          RestartPolicy: { Name: "no" },
          NetworkMode: this.options.networkMode,
          Memory: this.options.memoryLimitBytes,
          NanoCpus: this.options.cpuLimit === null ? 0 : Math.round(this.options.cpuLimit * 1e9),
          ShmSize: 128 * 1024 ** 2,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
        },
      },
    });
  }
  private createDefinition(machine: MachineRecord, transition: MachineTransition) {
    const { config } = DockerCreateDefinition.parse(transition.definition);
    const digest = createHash("sha256").update(JSON.stringify(config)).digest("hex");
    const disk: DockerMachineDisk = {
      kind: "docker-machine-v1",
      containerId: "0".repeat(64),
      volumeName: this.volumeName(machine),
      image: config.Image,
      createTransitionId: transition.id,
      diskLineage: machine.id,
      definitionDigest: digest,
    };
    const labels = this.labels(machine, disk);
    return {
      disk,
      config: {
        ...config,
        Labels: labels,
        HostConfig: {
          ...config.HostConfig,
          Mounts: [
            {
              Type: "volume",
              Source: disk.volumeName,
              Target: "/workspace",
              VolumeOptions: { Labels: labels },
            },
          ],
        },
      },
    };
  }

  async dispatch(
    machine: MachineRecord,
    transition: MachineTransition,
    options: MachineLifecycleOptions = {},
  ): Promise<TransitionResult> {
    options.signal?.throwIfAborted();
    return this.operationSignal.run(options.signal, () => this.dispatchOnce(machine, transition));
  }
  private async dispatchOnce(
    machine: MachineRecord,
    transition: MachineTransition,
  ): Promise<TransitionResult> {
    this.assertTransition(machine, transition);
    if (transition.phase !== "dispatched")
      throw new MachineConflictError("Docker mutation was already dispatched");
    if (
      transition.kind === "destroy" &&
      transition.before.state === "absent" &&
      transition.before.disk === null &&
      transition.before.instance === null
    )
      return {
        outcome: "settled",
        transitionId: transition.id,
        state: "destroyed",
        instance: null,
        disk: null,
      };
    if (transition.kind === "create") {
      const definition = this.createDefinition(machine, transition);
      const response = await this.request(
        "POST",
        `/containers/create?name=${this.name(machine)}`,
        definition.config,
      );
      if (response.status !== 201) return { outcome: "unknown" };
      const id = z.object({ Id: z.string().regex(containerId) }).parse(await response.json()).Id;
      const found = await this.inspectContainer(id);
      if (!found) return { outcome: "unknown" };
      await this.validateContainer(machine, { ...definition.disk, containerId: id }, found);
    } else {
      const disk = this.disk(machine, transition);
      const found = await this.inspectContainer(disk.containerId);
      if (transition.kind === "destroy" && transition.before.state === "destroying") {
        // The previous durable transition settled exact container removal.
        // This transition owns ONE volume mutation; it never replays DELETE CID.
        if (found) return { outcome: "unknown" };
        const volume = await this.validateVolume(machine, disk);
        if (volume) {
          const response = await this.request("DELETE", `/volumes/${disk.volumeName}`);
          if (response.status === 409) {
            const error = z
              .object({ message: z.string().max(4096) })
              .strict()
              .safeParse(await response.json());
            const prefix = `remove ${disk.volumeName}: volume is in use - [`;
            if (
              error.success &&
              error.data.message.startsWith(prefix) &&
              error.data.message.endsWith("]") &&
              /^[a-f0-9]{64}(?:, [a-f0-9]{64})*$/u.test(error.data.message.slice(prefix.length, -1))
            ) {
              // Moby's local-volume reference guard returns this refusal under
              // the name lock BEFORE invoking driver removal. This request is
              // finished without a side effect; a NEW durable transition can
              // retry after container deletion releases the remaining reference.
              // Arbitrary 409s, lost replies and timeouts never establish this.
              return {
                outcome: "settled",
                transitionId: transition.id,
                state: "destroying",
                instance: null,
                disk,
              };
            }
          }
          if (response.status !== 204) return { outcome: "unknown" };
        }
        return this.reconcileOnce(machine, transition);
      }
      if (!found && transition.kind === "destroy") return this.reconcileOnce(machine, transition);
      if (!found) return { outcome: "unknown" };
      await this.validateContainer(machine, disk, found);
      let response: Response;
      if (transition.kind === "resume") {
        if (
          transition.before.state !== "suspended" ||
          (found.State.Running && !found.State.Paused) ||
          (transition.before.instance !== null && !found.State.Paused) ||
          (transition.before.instance === null && found.State.Status !== "created")
        )
          return { outcome: "unknown" };
        response = await this.request(
          "POST",
          `/containers/${disk.containerId}/${found.State.Paused ? "unpause" : "start"}`,
        );
      } else if (transition.kind === "suspend") {
        if (transition.before.state !== "running" || !found.State.Running || found.State.Paused)
          return { outcome: "unknown" };
        response = await this.request("POST", `/containers/${disk.containerId}/pause`);
      } else {
        if (machine.demands.length || machine.target !== "destroyed")
          throw new MachineConflictError("Docker destruction still has live demand");
        response = await this.request("DELETE", `/containers/${disk.containerId}?force=true`);
      }
      if (response.status !== 204 && response.status !== 304) return { outcome: "unknown" };
    }
    return this.reconcileOnce(machine, transition);
  }

  async reconcile(
    machine: MachineRecord,
    transition: MachineTransition,
    options: MachineLifecycleOptions = {},
  ): Promise<TransitionResult> {
    options.signal?.throwIfAborted();
    return this.operationSignal.run(options.signal, () => this.reconcileOnce(machine, transition));
  }
  private async reconcileOnce(
    machine: MachineRecord,
    transition: MachineTransition,
  ): Promise<TransitionResult> {
    this.assertTransition(machine, transition);
    if (
      transition.kind === "destroy" &&
      transition.before.state === "absent" &&
      transition.before.disk === null &&
      transition.before.instance === null
    )
      return {
        outcome: "settled",
        transitionId: transition.id,
        state: "destroyed",
        instance: null,
        disk: null,
      };
    const disk =
      transition.kind === "create"
        ? this.createDefinition(machine, transition).disk
        : this.disk(machine, transition);
    const found = await this.inspectContainer(
      transition.kind === "create" ? this.name(machine) : disk.containerId,
    );
    if (transition.kind === "destroy") {
      if (found) return { outcome: "unknown" };
      const volume = await this.validateVolume(machine, disk);
      if (volume && transition.before.state === "destroying") return { outcome: "unknown" };
      return {
        outcome: "settled",
        transitionId: transition.id,
        state: volume ? "destroying" : "destroyed",
        instance: null,
        disk: volume ? disk : null,
      };
    }
    if (!found) return { outcome: "unknown" };
    if (transition.kind === "create") disk.containerId = found.Id;
    await this.validateContainer(machine, disk, found);
    if (found.State.Dead || found.State.Restarting) return { outcome: "unknown" };
    if (transition.kind === "create") {
      if (found.State.Status !== "created" || found.State.Running) return { outcome: "unknown" };
      return {
        outcome: "settled",
        transitionId: transition.id,
        state: "suspended",
        instance: null,
        disk,
      };
    }
    if (transition.kind === "suspend") {
      if (!found.State.Running || !found.State.Paused) return { outcome: "unknown" };
      return {
        outcome: "settled",
        transitionId: transition.id,
        state: "suspended",
        instance: structuredClone(transition.before.instance),
        disk,
      };
    }
    if (!found.State.Running || found.State.Paused) return { outcome: "unknown" };
    const reply = await this.transport.exec({
      instanceId: disk.containerId,
      argv: ["/usr/local/bin/opengeni-run", "--root", "/var/lib/opengeni-run", "capabilities"],
      ...(this.operationSignal.getStore() ? { signal: this.operationSignal.getStore()! } : {}),
    });
    if (reply.exitCode !== 0) return { outcome: "unknown" };
    const capabilities = JournalCapabilities.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reply.stdout)),
    );
    if (transition.before.instance && capabilities.bootId !== transition.before.instance.bootId)
      return { outcome: "unknown" };
    return {
      outcome: "settled",
      transitionId: transition.id,
      state: "running",
      instance: {
        id: disk.containerId,
        bootId: capabilities.bootId,
        diskLineage: disk.diskLineage,
      },
      disk,
    };
  }
}
