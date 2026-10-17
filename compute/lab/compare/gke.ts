/**
 * Agent Sandbox on GKE: SandboxClaims against SandboxWarmPools for creates,
 * the sandbox router for commands, and Pod Snapshots for suspend and resume,
 * the way its Python SDK drives them. Readiness comes from watches, not the
 * SDK's two-second polls, so no poll interval is added to their times.
 */
import { randomBytes } from "node:crypto";
import { condition, Informer, Kube, type KubeObject } from "./kube.ts";
import type { CreateKind, RunResult, Sandbox, System } from "./system.ts";

const CLAIMS = "/apis/extensions.agents.x-k8s.io/v1beta1";
const SANDBOXES = "/apis/agents.x-k8s.io/v1beta1";
const SNAPSHOTS = "/apis/podsnapshot.gke.io/v1";
const POD_NAME_ANNOTATION = "agents.x-k8s.io/pod-name";

export interface GkeOptions {
  server: string;
  token: string;
  caFile: string;
  namespace: string;
  /** The sandbox router, such as `http://10.0.0.5:8080`. */
  router: string;
  /** The warm pool claims take a ready pod from. */
  warmPool: string;
  /** A warm pool of zero replicas, for cold creates. */
  coldPool: string;
  /** The runtime server's port in the pod. */
  port?: number;
  timeoutMs?: number;
  /** A label value on every claim, so a run can be cleaned up. */
  runLabel: string;
}

export interface GkeSandbox extends Sandbox {
  /** The claim's name; `id` is the Sandbox's. */
  readonly claim: string;
  suspended: boolean;
  snapshots: number;
}

export const RUN_LABEL = "compare.lab/run";

export class Gke implements System<GkeSandbox> {
  readonly name = "agent-sandbox-gke";
  readonly restLevels = ["running", "snapshot"] as const;
  private readonly kube: Kube;
  private readonly claims: Informer;
  private readonly sandboxes: Informer;
  private readonly triggers: Informer;
  private readonly timeoutMs: number;
  private readonly port: number;

  constructor(private readonly options: GkeOptions) {
    this.kube = new Kube(options.server, options.token, options.caFile);
    const ns = options.namespace;
    this.claims = new Informer(this.kube, `${CLAIMS}/namespaces/${ns}/sandboxclaims`);
    this.sandboxes = new Informer(this.kube, `${SANDBOXES}/namespaces/${ns}/sandboxes`);
    this.triggers = new Informer(this.kube, `${SNAPSHOTS}/namespaces/${ns}/podsnapshotmanualtriggers`);
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.port = options.port ?? 8888;
  }

  async start(withSnapshots: boolean) {
    await Promise.all([this.claims.start(), this.sandboxes.start(), withSnapshots ? this.triggers.start() : Promise.resolve()]);
  }

  async create(kind: CreateKind, script: string, started: number) {
    if (kind === "template") throw new Error("Agent Sandbox has no template level between cold and warm pool");
    const claim = `cmp-${randomBytes(5).toString("hex")}`;
    await this.kube.request("POST", `${CLAIMS}/namespaces/${this.options.namespace}/sandboxclaims`, {
      apiVersion: "extensions.agents.x-k8s.io/v1beta1",
      kind: "SandboxClaim",
      metadata: { name: claim, labels: { [RUN_LABEL]: this.options.runLabel } },
      spec: { warmPoolRef: { name: kind === "pool" ? this.options.warmPool : this.options.coldPool } },
    });
    const postedMs = performance.now() - started;
    const ready = await this.claims.wait(
      claim,
      (object) => Boolean(object && (object.status?.sandbox as { name?: string } | undefined)?.name && condition(object, "Ready")?.status === "True"),
      this.timeoutMs,
      `claim ${claim} ready`,
    );
    const readyMs = performance.now() - started;
    const status = ready?.status?.sandbox as { name: string; podIPs?: string[] };
    const sandbox: GkeSandbox = { id: status.name, claim, suspended: false, snapshots: 0 };
    const run = await this.execute(sandbox, script, started, status.podIPs?.[0]);
    run.phases = { ...run.phases, claim_posted_ms: postedMs, claim_ready_ms: readyMs };
    return { sandbox, run };
  }

  async run(sandbox: GkeSandbox, script: string, started: number): Promise<RunResult> {
    const phases: Record<string, number> = {};
    let podIp: string | undefined;
    if (sandbox.suspended) {
      await this.kube.mergePatch(this.sandboxPath(sandbox), { spec: { operatingMode: "Running" } });
      phases.resume_patched_ms = performance.now() - started;
      const ready = await this.sandboxes.wait(
        sandbox.id,
        (object) => condition(object, "Ready")?.status === "True" && ((object?.status?.podIPs as string[] | undefined)?.length ?? 0) > 0,
        this.timeoutMs,
        `sandbox ${sandbox.id} resumed`,
      );
      phases.resumed_ready_ms = performance.now() - started;
      sandbox.suspended = false;
      podIp = (ready?.status?.podIPs as string[])[0];
    } else {
      podIp = (this.sandboxes.get(sandbox.id)?.status?.podIPs as string[] | undefined)?.[0];
    }
    const run = await this.execute(sandbox, script, started, podIp);
    run.phases = { ...run.phases, ...phases };
    return run;
  }

  /** Runs `script` through the router; the runtime answers once it exits. */
  private async execute(sandbox: GkeSandbox, script: string, started: number, podIp?: string): Promise<RunResult> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Sandbox-ID": sandbox.id,
      "X-Sandbox-Namespace": this.options.namespace,
      "X-Sandbox-Port": String(this.port),
    };
    if (podIp) headers["X-Sandbox-Pod-IP"] = podIp;
    const response = await fetch(`${this.options.router}/execute`, {
      method: "POST",
      headers,
      body: JSON.stringify({ command: script }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const headersMs = performance.now() - started;
    const text = await response.text();
    const doneMs = performance.now() - started;
    if (!response.ok) throw new Error(`router ${response.status}: ${text.slice(0, 200)}`);
    const body = JSON.parse(text) as { stdout: string; stderr: string; exit_code: number };
    // The runtime replies once the command exits, so its first byte of
    // output arrives with everything else.
    return { firstByteMs: doneMs, doneMs, output: body.stdout, status: body.exit_code, phases: { response_headers_ms: headersMs } };
  }

  async rest(sandbox: GkeSandbox, level: string): Promise<void> {
    if (level === "running") return;
    if (level !== "snapshot") throw new Error(`unknown level ${level}`);
    if (sandbox.suspended) return;
    const object = this.sandboxes.get(sandbox.id);
    const pod = object?.metadata.annotations?.[POD_NAME_ANNOTATION] ?? sandbox.id;
    sandbox.snapshots += 1;
    const trigger = `${sandbox.id.slice(0, 40)}-${sandbox.snapshots}-${randomBytes(3).toString("hex")}`;
    const triggers = `${SNAPSHOTS}/namespaces/${this.options.namespace}/podsnapshotmanualtriggers`;
    await this.kube.request("POST", triggers, {
      apiVersion: "podsnapshot.gke.io/v1",
      kind: "PodSnapshotManualTrigger",
      metadata: { name: trigger, labels: { [RUN_LABEL]: this.options.runLabel } },
      spec: { targetPod: pod },
    });
    await this.triggers.wait(
      trigger,
      (found) => {
        const triggered = condition(found, "Triggered");
        if (triggered?.status === "False" && (triggered.reason === "Failed" || triggered.reason === "Error")) {
          throw new Error(`snapshot of ${pod} failed: ${triggered.message}`);
        }
        return triggered?.status === "True" && triggered.reason === "Complete";
      },
      this.timeoutMs,
      `snapshot of ${pod}`,
    );
    await this.kube.mergePatch(this.sandboxPath(sandbox), { spec: { operatingMode: "Suspended" } });
    await this.sandboxes.wait(sandbox.id, (found) => condition(found, "Suspended")?.status === "True", this.timeoutMs, `sandbox ${sandbox.id} suspended`);
    sandbox.suspended = true;
    // The trigger has done its work; the snapshot itself stays.
    void this.kube.request("DELETE", `${triggers}/${trigger}`).catch(() => undefined);
  }

  private sandboxPath(sandbox: GkeSandbox) {
    return `${SANDBOXES}/namespaces/${this.options.namespace}/sandboxes/${sandbox.id}`;
  }

  async remove(sandbox: GkeSandbox): Promise<void> {
    await this.kube.request("DELETE", `${CLAIMS}/namespaces/${this.options.namespace}/sandboxclaims/${sandbox.claim}`);
  }

  async list(): Promise<string[]> {
    return this.claims.names();
  }

  async describe(): Promise<Record<string, unknown>> {
    const version = await this.kube.request<Record<string, unknown>>("GET", "/version");
    const pools = await this.kube.request<{ items: KubeObject[] }>("GET", `${CLAIMS}/namespaces/${this.options.namespace}/sandboxwarmpools`);
    return {
      system: this.name,
      kubernetes: version.gitVersion,
      warmPools: pools.items.map((pool) => ({ name: pool.metadata.name, replicas: pool.spec?.replicas, ready: pool.status?.readyReplicas })),
    };
  }

  async close(): Promise<void> {
    this.claims.stop();
    this.sandboxes.stop();
    this.triggers.stop();
  }
}
