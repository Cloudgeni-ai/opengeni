import type { Computer, Tool } from "@openai/agents";
import { Capability, type SandboxSessionLike } from "@openai/agents/sandbox";

export type ComputerToolMode = "function-image" | "disabled" | "function-text";

export type SandboxComputerOptions = {
  display?: string;
  dimensions?: [number, number];
  runAs?: string;
  typeDelayMs?: number;
  readOnly?: boolean;
  screenshotTmpDir?: string;
  screenshotWarmupBudgetMs?: number;
  screenshotRetryDelayMs?: number;
  screenshotReadbackTimeoutMs?: number;
  abortSignal?: AbortSignal;
  prepare?: (session: SandboxSessionLike) => Promise<void>;
};

export class ComputerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputerUnavailableError";
  }
}

export type ScreenshotReadErrorCode =
  | "aborted"
  | "capture_outcome_unknown"
  | "chunk_limit_exceeded"
  | "cleanup_failed"
  | "command_failed"
  | "command_outcome_unknown"
  | "invalid_chunk_output"
  | "invalid_size_output"
  | "read_timeout"
  | "size_limit_exceeded"
  | "truncated_read";

export class ScreenshotReadError extends Error {
  cleanupFailed = false;

  constructor(
    public readonly code: ScreenshotReadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ScreenshotReadError";
  }
}

export class ComputerReadOnlyError extends Error {
  constructor() {
    super("computer-use is read-only — write actions are disabled");
    this.name = "ComputerReadOnlyError";
  }
}

export class ComputerActionError extends Error {
  constructor(
    public cmd: string,
    public exitCode: number,
    public stderr: string,
  ) {
    super(`computer action failed (${exitCode}): ${cmd}${stderr ? `\n${stderr}` : ""}`);
    this.name = "ComputerActionError";
  }
}

type ComputerButton = "left" | "right" | "wheel" | "back" | "forward";

/**
 * @deprecated Agent desktop interaction moved to managed ComputerSession tools.
 * This compatibility shell preserves the runtime 1.x constructor and method
 * surface without reviving direct sandbox desktop control.
 */
export class SandboxComputer implements Computer {
  readonly environment = "ubuntu" as const;
  readonly dimensions: [number, number];

  constructor(
    private session: SandboxSessionLike,
    options: SandboxComputerOptions = {},
  ) {
    this.dimensions = options.dimensions ?? [1280, 800];
  }

  rebind(session: SandboxSessionLike): void {
    this.session = session;
  }

  async screenshot(): Promise<string> {
    return await this.unavailable();
  }

  async click(_x: number, _y: number, _button: ComputerButton): Promise<void> {
    await this.unavailable();
  }

  async doubleClick(_x: number, _y: number): Promise<void> {
    await this.unavailable();
  }

  async move(_x: number, _y: number): Promise<void> {
    await this.unavailable();
  }

  async scroll(_x: number, _y: number, _scrollX: number, _scrollY: number): Promise<void> {
    await this.unavailable();
  }

  async type(_text: string): Promise<void> {
    await this.unavailable();
  }

  async keypress(_keys: string[]): Promise<void> {
    await this.unavailable();
  }

  async drag(_path: [number, number][]): Promise<void> {
    await this.unavailable();
  }

  async wait(): Promise<void> {
    await this.unavailable();
  }

  private async unavailable(): Promise<never> {
    void this.session;
    throw new ComputerUnavailableError(
      "legacy sandbox computer control is unavailable; use managed ComputerSession tools",
    );
  }
}

export type ComputerUseArgs = {
  dimensions?: [number, number];
  readOnly?: boolean;
  display?: string;
  abortSignal?: AbortSignal;
  needsApproval?: boolean | ((ctx: unknown, action: unknown) => boolean | Promise<boolean>);
  /** @deprecated Use managed ComputerSession tools. */
  imageFunctionResults?: boolean;
  toolMode?: ComputerToolMode;
  onReady?: (session: SandboxSessionLike) => Promise<void>;
  onRetainableSessionImageOutput?: (input: {
    toolName: "view_image" | "computer_screenshot";
    toolCallId: string;
    output: unknown;
  }) => Promise<void>;
};

/** @deprecated Use managed ComputerSession tools. */
export function computerUse(args: ComputerUseArgs = {}): ComputerUseCapability {
  return new ComputerUseCapability(args);
}

/** @deprecated Use managed ComputerSession tools. */
export class ComputerUseCapability extends Capability {
  readonly type = "computer-use";

  constructor(private readonly args: ComputerUseArgs = {}) {
    super();
  }

  override tools(): Tool<unknown>[] {
    void this.args;
    return [];
  }
}
