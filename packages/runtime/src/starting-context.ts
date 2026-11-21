import { Capability, type SandboxSessionLike } from "@openai/agents/sandbox";
import { sandboxCommandOutput, sandboxCommandStillRunning } from "./sandbox/command-result";

/**
 * Starting context (OPENGENI_EXPERIMENT_TOOL_EFFICIENCY): the workspace root's
 * Git status, a short top-level listing and its AGENTS.md, read once before a
 * session's first model request and stored as one history item (see
 * `@opengeni/contracts` `startingContextItem`). Most sessions otherwise spend
 * their first steps on exactly these reads. The workspace root and mounted
 * resources are already in the filesystem layout item, so they are not
 * repeated. A workspace that cannot answer gets no item; the session runs as
 * it would without one.
 */

const MAX_STATUS_LINES = 40;
const MAX_LISTING_ENTRIES = 80;
const MAX_AGENTS_BYTES = 6_000;
const PROBE_TIMEOUT_MS = 10_000;

const SECTION = "@@opengeni-starting-context:";

/** One shell command that prints the three sections, each bounded. */
export const STARTING_CONTEXT_PROBE = [
  "export LC_ALL=C",
  `if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then printf '%s\\n' '${SECTION}git'; git -c core.quotepath=off status --short --branch 2>/dev/null | head -n ${MAX_STATUS_LINES + 2}; fi`,
  `printf '%s\\n' '${SECTION}ls'`,
  `ls -A 2>/dev/null | head -n ${MAX_LISTING_ENTRIES + 1}`,
  `if [ -f AGENTS.md ]; then printf '%s\\n' '${SECTION}agents'; head -c ${MAX_AGENTS_BYTES + 1} AGENTS.md; fi`,
  "true",
].join("; ");

function boundedLines(lines: readonly string[], max: number, noun: string): string {
  const kept = lines.slice(0, max);
  return lines.length > max ? `${kept.join("\n")}\n[more ${noun} not shown]` : kept.join("\n");
}

/**
 * The model-visible block for the probe's output, or null when the output is
 * not the probe's (the command failed before printing its sections).
 */
export function renderStartingContext(output: string): string | null {
  const sections = new Map<string, string>();
  for (const part of output.split(SECTION).slice(1)) {
    const newline = part.indexOf("\n");
    const name = newline < 0 ? part : part.slice(0, newline);
    sections.set(name.trim(), newline < 0 ? "" : part.slice(newline + 1));
  }
  const ls = sections.get("ls");
  if (ls === undefined) return null;
  const blocks: string[] = [];
  const git = sections.get("git");
  if (git !== undefined) {
    // The first line is the branch line, then one line per changed file.
    const lines = git.split("\n").filter((line) => line.length > 0);
    blocks.push(
      `$ git status --short --branch\n${lines.length ? boundedLines(lines, MAX_STATUS_LINES + 1, "changed files") : "(no output)"}`,
    );
  }
  const listing = ls.split("\n").filter((line) => line.length > 0);
  blocks.push(
    `$ ls -A\n${listing.length ? boundedLines(listing, MAX_LISTING_ENTRIES, "entries") : "(empty)"}`,
  );
  const agents = sections.get("agents");
  if (agents !== undefined) {
    const bytes = Buffer.from(agents, "utf8");
    const cut = bytes.length > MAX_AGENTS_BYTES;
    // A cut never leaves a partial character behind.
    const text = (cut ? bytes.subarray(0, MAX_AGENTS_BYTES) : bytes)
      .toString("utf8")
      .replace(/\uFFFD$/u, "")
      .trimEnd();
    blocks.push(
      `$ cat AGENTS.md\n${text}${cut ? `\n[AGENTS.md continues past ${MAX_AGENTS_BYTES} bytes; read the file for the rest.]` : ""}`,
    );
  }
  return blocks.join("\n\n");
}

export type StartingContextCommandRunner = (
  session: SandboxSessionLike,
  args: { cmd: string; runAs?: string; yieldTimeMs: number },
) => Promise<unknown>;

/** Read the starting context from the bound workspace, or null when it cannot. */
export async function probeStartingContext(
  session: SandboxSessionLike,
  run: StartingContextCommandRunner,
  runAs?: string,
): Promise<string | null> {
  try {
    const result = await run(session, {
      cmd: STARTING_CONTEXT_PROBE,
      ...(runAs ? { runAs } : {}),
      yieldTimeMs: PROBE_TIMEOUT_MS,
    });
    if (sandboxCommandStillRunning(result)) return null;
    return renderStartingContext(sandboxCommandOutput(result));
  } catch (error) {
    console.warn("[starting-context] probe failed", {
      error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    });
    return null;
  }
}

/**
 * Reads the starting context once per bound run, before the first model
 * request, and hands it to `publish`. It adds no tools and no system-prompt
 * text, so the prompt prefix is the same with and without it.
 */
export class StartingContextCapability extends Capability {
  readonly type = "starting-context";
  private publication?: Promise<void>;

  constructor(
    private readonly options: {
      run: StartingContextCommandRunner;
      publish: (text: string | null) => Promise<void>;
    },
  ) {
    super();
  }

  override bind(session: SandboxSessionLike): this {
    if (this._session !== session) delete this.publication;
    return super.bind(session);
  }

  override async instructions(): Promise<string | null> {
    if (!this.publication) {
      const session = this._session;
      const publication = (
        session
          ? probeStartingContext(session, this.options.run, this._runAs)
          : Promise.resolve(null)
      ).then((text) => this.options.publish(text));
      this.publication = publication;
      publication.catch(() => {
        if (this.publication === publication) delete this.publication;
      });
    }
    await this.publication;
    return null;
  }
}
