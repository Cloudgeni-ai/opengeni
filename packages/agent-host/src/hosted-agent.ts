// The connected-machine agent as the app's own helper process. The app starts
// `opengeni-agent run`, restarts it when it stops unexpectedly, and stops it
// when this computer is paused or the app quits. Because the app starts it,
// macOS attributes the agent's Screen Recording and Accessibility use to the
// app, so people grant them to "Opengeni", the app they know.

export type HostedAgentState =
  /** Not running, by choice. */
  | "stopped"
  /** Started and alive. */
  | "running"
  /** Stopped unexpectedly; it starts again shortly. */
  | "restarting"
  /** Another copy of the agent already serves this computer. */
  | "elsewhere";

/** The part of a child process the supervisor uses. */
export interface AgentChild {
  readonly pid: number | undefined;
  onExit(listener: (code: number | null) => void): void;
}

export interface HostedAgentDeps {
  /** Starts `<agent> run --api-url <url>` with the hosted-agent environment. */
  spawn(apiUrl: string): AgentChild;
  /** Asks the agent to stop cleanly, then ends it and its helpers if it doesn't. */
  terminate(child: AgentChild): Promise<void>;
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  onChange(): void;
}

/** The agent's exit status asking to be started again, e.g. after a Windows update. */
export const RESTART_EXIT_CODE = 75;
/** A run this long counts as healthy, so the next failure starts again quickly. */
const HEALTHY_RUN_MS = 60_000;
/** A clean exit this soon means another agent holds the single-instance lock. */
const INSTANT_EXIT_MS = 5_000;
const ELSEWHERE_RETRY_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;

export class HostedAgent {
  private child: AgentChild | null = null;
  private wanted = false;
  private apiUrl: string | null = null;
  private startedAt = 0;
  private failures = 0;
  private timer: unknown = null;
  private current: HostedAgentState = "stopped";
  private stopping: Promise<void> | null = null;

  constructor(private readonly deps: HostedAgentDeps) {}

  get state(): HostedAgentState {
    return this.current;
  }

  /** Keep the agent running, serving every connection it has. */
  start(apiUrl: string): void {
    this.wanted = true;
    this.apiUrl = apiUrl;
    if (this.child || this.stopping) return;
    this.cancelTimer();
    this.launch();
  }

  /** Stop the agent and keep it stopped. */
  async stop(): Promise<void> {
    this.wanted = false;
    this.cancelTimer();
    await this.end();
    this.set("stopped");
  }

  /** Start a fresh agent process, e.g. so it sees a permission granted since it started. */
  async restart(): Promise<void> {
    if (!this.wanted || !this.apiUrl) return;
    this.cancelTimer();
    await this.end();
    if (this.wanted && !this.child) this.launch();
  }

  private launch(): void {
    if (!this.apiUrl) return;
    this.startedAt = this.deps.now();
    let child: AgentChild;
    try {
      child = this.deps.spawn(this.apiUrl);
    } catch {
      this.retry(this.backoff());
      return;
    }
    this.child = child;
    this.set("running");
    child.onExit((code) => this.exited(child, code));
  }

  private exited(child: AgentChild, code: number | null): void {
    if (this.child !== child) return;
    this.child = null;
    if (!this.wanted || this.stopping) return;
    const ranFor = this.deps.now() - this.startedAt;
    if (code === RESTART_EXIT_CODE) {
      this.failures = 0;
      this.launch();
      return;
    }
    if (code === 0 && ranFor < INSTANT_EXIT_MS) {
      this.set("elsewhere");
      this.retry(ELSEWHERE_RETRY_MS);
      return;
    }
    if (ranFor >= HEALTHY_RUN_MS) this.failures = 0;
    this.retry(this.backoff());
  }

  private backoff(): number {
    this.failures += 1;
    return Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** (this.failures - 1));
  }

  private retry(ms: number): void {
    if (this.current !== "elsewhere") this.set("restarting");
    this.cancelTimer();
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      if (this.wanted && !this.child && !this.stopping) this.launch();
    }, ms);
  }

  private async end(): Promise<void> {
    if (this.stopping) return await this.stopping;
    const child = this.child;
    if (!child) return;
    this.stopping = this.deps.terminate(child).finally(() => {
      if (this.child === child) this.child = null;
      this.stopping = null;
    });
    await this.stopping;
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  private set(state: HostedAgentState): void {
    if (this.current === state) return;
    this.current = state;
    this.deps.onChange();
  }
}
