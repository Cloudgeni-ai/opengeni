// The computer and window an agent is working in.
//
// Computer tools may omit computerSessionId and targetId to keep working in
// the window the agent used last, as browser tools keep using the current
// tab. A step then costs a few output tokens instead of two identifiers, and
// output tokens dominate a step's model latency. The remembered window lives
// for one turn attempt. A call that omits computerSessionId before any
// computer call in that attempt uses this session's most recently used live
// ComputerSession; a computer has no selected window, so omitting targetId
// then needs a window this attempt has already used.

export class ComputerTargetResolutionError extends Error {
  constructor(
    readonly code: "computer_session_required" | "computer_target_required",
    message: string,
  ) {
    super(message);
    this.name = "ComputerTargetResolutionError";
  }
}

export type CurrentComputerWindowDeps = {
  /** This agent session's most recently used live ComputerSession, if any. */
  latestLiveSession: () => Promise<string | null>;
};

export type ResolvedComputerSession = {
  computerSessionId: string;
  /** True when the identifier came from memory or lookup, not the caller. */
  implicit: boolean;
};

export type ResolvedComputerTarget = ResolvedComputerSession & {
  targetId: string;
  implicitTarget: boolean;
};

export class CurrentComputerWindow {
  private current: { computerSessionId: string; targetId: string | null } | null = null;

  constructor(private readonly deps: CurrentComputerWindowDeps) {}

  /** Record the computer and, when known, the window a successful call used. */
  use(computerSessionId: string, targetId?: string | null): void {
    if (targetId === undefined || targetId === null) {
      if (this.current?.computerSessionId !== computerSessionId) {
        this.current = { computerSessionId, targetId: null };
      }
      return;
    }
    this.current = { computerSessionId, targetId };
  }

  forgetSession(computerSessionId: string): void {
    if (this.current?.computerSessionId === computerSessionId) this.current = null;
  }

  /** A call that relied on remembered identifiers found them gone: resolve
   * afresh next time. */
  failed(resolved: ResolvedComputerSession & { implicitTarget?: boolean }): void {
    if (resolved.implicit) this.forgetSession(resolved.computerSessionId);
    else if (
      resolved.implicitTarget &&
      this.current?.computerSessionId === resolved.computerSessionId
    ) {
      this.current = { computerSessionId: resolved.computerSessionId, targetId: null };
    }
  }

  async session(computerSessionId: string | undefined): Promise<ResolvedComputerSession> {
    if (computerSessionId !== undefined) return { computerSessionId, implicit: false };
    if (this.current) return { computerSessionId: this.current.computerSessionId, implicit: true };
    const latest = await this.deps.latestLiveSession();
    if (!latest) {
      throw new ComputerTargetResolutionError(
        "computer_session_required",
        "This session has no open computer. Call computer_open first, or pass computerSessionId.",
      );
    }
    return { computerSessionId: latest, implicit: true };
  }

  async target(value: {
    computerSessionId?: string | undefined;
    targetId?: string | undefined;
  }): Promise<ResolvedComputerTarget> {
    const session = await this.session(value.computerSessionId);
    if (value.targetId !== undefined) {
      return { ...session, targetId: value.targetId, implicitTarget: false };
    }
    if (this.current?.computerSessionId === session.computerSessionId && this.current.targetId) {
      return { ...session, targetId: this.current.targetId, implicitTarget: true };
    }
    throw new ComputerTargetResolutionError(
      "computer_target_required",
      "No window of this computer has been used yet in this turn. Pass targetId from computer_open or computer_targets.",
    );
  }
}
