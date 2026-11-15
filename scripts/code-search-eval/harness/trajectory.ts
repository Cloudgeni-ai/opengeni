import type { Prediction, Span } from "./types";

/**
 * Arms (a) and (d) run as real Opengeni agent sessions. Their localization is read back from the
 * session event log: the spans the agent actually viewed (what entered its context), and the
 * files and spans its final answer names. Both are scored, since an agent can see the right code
 * and still fail to report it.
 */
export type AgentEvent = { type: string; payload?: Record<string, unknown> };

export type TrajectoryLocalization = {
  viewed: Prediction;
  searchedFiles: string[];
  editedFiles: string[];
  calls: { explore: number; total: number };
};

const WHOLE_FILE = 1_000_000;

function relativize(path: string, repoRoots: string[]): string | null {
  let p = path.replace(/^['"]|['"]$/g, "");
  for (const root of repoRoots)
    if (p.startsWith(`${root}/`)) p = p.slice(root.length + 1);
  p = p.replace(/^\.\//, "");
  if (
    !p ||
    p.startsWith("/") ||
    p.startsWith("-") ||
    p.includes("*") ||
    p.includes("$")
  )
    return null;
  return p;
}

/** Spans a shell command shows: sed -n ranges, head/tail, cat/nl/less of whole files. */
export function viewedSpans(cmd: string, repoRoots: string[] = []): Span[] {
  const spans: Span[] = [];
  const add = (path: string | undefined, start: number, end: number) => {
    const file = path ? relativize(path, repoRoots) : null;
    if (file) spans.push({ file, start, end });
  };
  for (const m of cmd.matchAll(
    /\bsed\s+-n\s+['"]?(\d+)(?:,(\d+))?p['"]?\s+([^\s;|&><]+)/g,
  ))
    add(m[3], Number(m[1]), Number(m[2] ?? m[1]));
  for (const m of cmd.matchAll(/\bhead\s+(?:-n\s*|-)(\d+)\s+([^\s;|&><]+)/g))
    add(m[2], 1, Number(m[1]));
  for (const m of cmd.matchAll(
    /(?:^|[;&|(]\s*)(?:cat|nl\s+-ba|less|bat)\s+((?:[^\s;|&><]+\s*)+)/g,
  ))
    for (const path of m[1]!.trim().split(/\s+/))
      if (!path.startsWith("-")) add(path, 1, WHOLE_FILE);
  return spans;
}

/** Files named in search output lines such as `path:12:text` (rg -n / grep -rn). */
export function searchHitFiles(
  output: string,
  repoRoots: string[] = [],
): string[] {
  const files: string[] = [];
  for (const m of output.matchAll(/^([^\s:][^:\n]*\.[A-Za-z0-9]+):\d+[:-]/gm)) {
    const file = relativize(m[1]!, repoRoots);
    if (file && !files.includes(file)) files.push(file);
  }
  return files;
}

export function editedFiles(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Update|Delete) File: (.+)$/gm)].map(
    (m) => m[1]!.trim(),
  );
}

const EXPLORE =
  /\b(rg|grep|find|ls|cat|sed|head|tail|nl|tree|git\s+(?:grep|show|log))\b/;

export function localizeTrajectory(
  events: AgentEvent[],
  repoRoots: string[] = [],
): TrajectoryLocalization {
  const spans: Span[] = [];
  const searched: string[] = [];
  const edited: string[] = [];
  const kinds = new Map<string, string>();
  let explore = 0;
  let total = 0;
  for (const event of events) {
    const p = event.payload ?? {};
    if (event.type === "agent.toolCall.created") {
      total++;
      const raw = p.arguments;
      const args = (
        typeof raw === "string" ? safeJson(raw) : (raw ?? {})
      ) as Record<string, unknown>;
      const name = String(p.name ?? "");
      if (name === "exec_command" && typeof args.cmd === "string") {
        const isExplore = EXPLORE.test(args.cmd);
        if (isExplore) explore++;
        kinds.set(String(p.id), isExplore ? "explore" : "other");
        spans.push(...viewedSpans(args.cmd, repoRoots));
      } else if (name === "apply_patch" && typeof args.patch === "string") {
        for (const f of editedFiles(args.patch))
          if (!edited.includes(f)) edited.push(f);
      } else if (name === "code_search") {
        kinds.set(String(p.id), "code_search");
        explore++;
      }
    } else if (event.type === "agent.toolCall.output") {
      const kind = kinds.get(String(p.id));
      const out =
        typeof p.output === "string"
          ? p.output
          : JSON.stringify(p.output ?? "");
      if (kind === "explore")
        for (const f of searchHitFiles(out, repoRoots))
          if (!searched.includes(f)) searched.push(f);
      if (kind === "code_search")
        for (const m of out.matchAll(/^== (.+?):(\d+)-(\d+)\s/gm))
          spans.push({ file: m[1]!, start: Number(m[2]), end: Number(m[3]) });
    }
  }
  const viewedFiles: string[] = [];
  for (const s of spans)
    if (!viewedFiles.includes(s.file)) viewedFiles.push(s.file);
  return {
    viewed: { files: viewedFiles, spans },
    searchedFiles: searched,
    editedFiles: edited,
    calls: { explore, total },
  };
}

/** Clip whole-file placeholders to the real line count so precision counts what was shown. */
export function clipToLineCounts(
  prediction: Prediction,
  lineCount: (file: string) => number | undefined,
): Prediction {
  return {
    files: prediction.files,
    spans: prediction.spans.flatMap((s) => {
      const n = lineCount(s.file);
      if (n === undefined) return [];
      return s.start > n ? [] : [{ ...s, end: Math.min(s.end, n) }];
    }),
  };
}

/** `path:start-end` or `path:line` references in a final answer, in order. */
export function predictionFromAnswer(
  answer: string,
  repoRoots: string[] = [],
): Prediction {
  const spans: Span[] = [];
  for (const m of answer.matchAll(
    /([\w./-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?/g,
  )) {
    const file = relativize(m[1]!, repoRoots);
    if (file)
      spans.push({ file, start: Number(m[2]), end: Number(m[3] ?? m[2]) });
  }
  return { files: [...new Set(spans.map((s) => s.file))], spans };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
