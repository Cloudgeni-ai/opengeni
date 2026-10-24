// The browser tab an agent is working in.
//
// Browser tools may omit browserSessionId and targetId to keep working in the
// tab the agent used last, the way a person keeps using the tab in front of
// them. A step then costs a few output tokens instead of two identifiers, and
// output tokens dominate a browser step's model latency. The remembered tab
// lives for one turn attempt; a call that omits identifiers before any browser
// call in that attempt resolves this session's most recently used live
// browser and its selected tab.

export class BrowserTargetResolutionError extends Error {
  constructor(
    readonly code: "browser_session_required" | "browser_target_required" | "browser_resumed",
    message: string,
  ) {
    super(message);
    this.name = "BrowserTargetResolutionError";
  }
}

export type CurrentBrowserTabDeps = {
  /** This agent session's live BrowserSessions. */
  listLiveSessions: () => Promise<ReadonlyArray<{ id: string; lastUsedAt: string }>>;
  /** The tabs of one BrowserSession. */
  listTargets: (
    browserSessionId: string,
  ) => Promise<ReadonlyArray<{ id: string; kind: string; selected: boolean }>>;
};

export type ResolvedBrowserSession = {
  browserSessionId: string;
  /** True when the identifier came from memory or lookup, not the caller. */
  implicit: boolean;
};

export type ResolvedBrowserTarget = ResolvedBrowserSession & {
  targetId: string;
  implicitTarget: boolean;
};

export class CurrentBrowserTab {
  private current: { browserSessionId: string; targetId: string | null } | null = null;

  constructor(private readonly deps: CurrentBrowserTabDeps) {}

  /** Record the session and, when known, the tab a successful call used. */
  use(browserSessionId: string, targetId?: string | null): void {
    if (targetId === undefined) {
      if (this.current?.browserSessionId !== browserSessionId) {
        this.current = { browserSessionId, targetId: null };
      }
      return;
    }
    this.current = { browserSessionId, targetId };
  }

  forgetTarget(browserSessionId: string, targetId: string): void {
    if (this.current?.browserSessionId === browserSessionId && this.current.targetId === targetId) {
      this.current = { browserSessionId, targetId: null };
    }
  }

  forgetSession(browserSessionId: string): void {
    if (this.current?.browserSessionId === browserSessionId) this.current = null;
  }

  /** A call that relied on remembered identifiers failed: resolve afresh next time. */
  failed(resolved: ResolvedBrowserSession & { implicitTarget?: boolean }): void {
    if (resolved.implicit) this.forgetSession(resolved.browserSessionId);
    else if (
      resolved.implicitTarget &&
      this.current?.browserSessionId === resolved.browserSessionId
    ) {
      this.current = { browserSessionId: resolved.browserSessionId, targetId: null };
    }
  }

  async session(browserSessionId: string | undefined): Promise<ResolvedBrowserSession> {
    if (browserSessionId !== undefined) return { browserSessionId, implicit: false };
    if (this.current) return { browserSessionId: this.current.browserSessionId, implicit: true };
    const sessions = [...(await this.deps.listLiveSessions())].sort((left, right) =>
      right.lastUsedAt.localeCompare(left.lastUsedAt),
    );
    const latest = sessions[0];
    if (!latest) {
      throw new BrowserTargetResolutionError(
        "browser_session_required",
        "This session has no open browser. Call browser_open first, or pass browserSessionId.",
      );
    }
    return { browserSessionId: latest.id, implicit: true };
  }

  async target(value: {
    browserSessionId?: string | undefined;
    targetId?: string | undefined;
  }): Promise<ResolvedBrowserTarget> {
    const session = await this.session(value.browserSessionId);
    if (value.targetId !== undefined) {
      return { ...session, targetId: value.targetId, implicitTarget: false };
    }
    if (this.current?.browserSessionId === session.browserSessionId && this.current.targetId) {
      return { ...session, targetId: this.current.targetId, implicitTarget: true };
    }
    const pages = (await this.deps.listTargets(session.browserSessionId)).filter(
      (target) => target.kind === "page" || target.kind === "popup",
    );
    const chosen =
      pages.find((target) => target.selected) ?? (pages.length === 1 ? pages[0] : null);
    if (!chosen) {
      throw new BrowserTargetResolutionError(
        "browser_target_required",
        pages.length === 0
          ? "This browser has no open tab. Open one with browser_tabs operation=open."
          : `This browser has ${pages.length} tabs and none is selected. Pass targetId from browser_tabs operation=list.`,
      );
    }
    return { ...session, targetId: chosen.id, implicitTarget: true };
  }
}

/** `role:name` as a bare locator string: a role word, a colon, and the
 * element's name. Refs are letters and hex digits, never a colon. */
// Roles can be several words ("push button" in Linux readings); no ref has a
// space, and none starts with a letters-only word and a colon.
const ROLE_SHORTHAND = /^([A-Za-z][A-Za-z _-]*):(.*\S.*)$/su;

/** Words before the colon that name another locator kind rather than a role,
 * for surfaces where they are not also roles: a page has no `label` or
 * `placeholder` role, but a Linux desktop reading does have `label`. */
export type LocatorKindWords = Readonly<Record<string, "label" | "placeholder">>;

/** The page locator kinds a model may name with `kind:text`. */
export const BROWSER_LOCATOR_KIND_WORDS: LocatorKindWords = {
  label: "label",
  placeholder: "placeholder",
};

/** A bare string passed where a locator is expected: `role:name` names the
 * element with that role and exact name, anything else is an element ref. */
function expandLocatorString(value: string, kindWords: LocatorKindWords): Record<string, unknown> {
  const role = ROLE_SHORTHAND.exec(value);
  if (!role) return { kind: "ref", ref: value };
  const word = role[1]!.trim();
  const name = role[2]!.trim();
  const kind = Object.hasOwn(kindWords, word.toLowerCase())
    ? kindWords[word.toLowerCase()]
    : undefined;
  return kind
    ? { kind, text: name }
    : { kind: "role", role: word.toLowerCase(), name, exact: true };
}

/** Locators passed as bare strings (an element ref, or `role:name`),
 * expanded to locator objects, in an action and its batch items. */
export function expandRefShorthand(action: unknown, kindWords: LocatorKindWords = {}): unknown {
  if (!action || typeof action !== "object" || Array.isArray(action)) return action;
  const record = action as Record<string, unknown>;
  let expanded: Record<string, unknown> | null = null;
  for (const field of ["locator", "from", "to"] as const) {
    const value = record[field];
    if (typeof value === "string") {
      expanded ??= { ...record };
      expanded[field] = expandLocatorString(value, kindWords);
    }
  }
  if (Array.isArray(record.actions)) {
    expanded ??= { ...record };
    expanded.actions = record.actions.map((item) => expandRefShorthand(item, kindWords));
  }
  return expanded ?? action;
}
