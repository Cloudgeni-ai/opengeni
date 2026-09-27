/**
 * judge.ts - the only place where scores come from: Jev answers one probability per judged item.
 *
 * All Jev wording lives in PROMPTS below (one place to review). Design rules followed:
 *  - one state + many narrow Nouls per request (fan-out); one Noul per candidate (multi-select)
 *  - criteria text is explicit (in the state for 60-file triage batches, per question for passages)
 *  - the literal question text is inlined in every question (no `collections[i]`-style indirection)
 *  - state holds only the candidates being judged (filtered by code first)
 *  - no counting, math or dates asked of Jev; code combines answers
 * A Jev failure is not replaced by lexical scores: it propagates and the whole search fails.
 */
import { noul, type JevAnswer, type JevClient, type JevNoulQuestion } from "../client";
import type { CodeSearchConfig } from "./config";

export interface JudgeContext {
  question: string;
  subQuestions: string[];
}

export interface FileItem {
  id: string;
  path: string;
  /** path + best hit lines, as shown to the judge */
  descriptor: string;
  /** Normalized lexical score; used only if Jev returns no usable number for this item. */
  lex: number;
}

export interface PassageItem {
  id: string;
  path: string;
  start: number;
  end: number;
  /** rendered `N| text` */
  text: string;
  label?: string | undefined;
  lex: number;
  lexCov: number[];
}

export interface LeadItem {
  id: string;
  name: string;
  seenAt: string;
  context: string;
  lex: number;
}

export interface PassageScore {
  rel: number;
  cov: number[];
}

export interface StatusScore {
  overall: number;
  subs: number[];
}

export interface StageStats {
  requests: number;
  inputTokens: number;
  costUsd: number;
  ms: number;
}

export type JudgeEvent = (stage: string, data: Record<string, unknown>) => void;

// ---------------------------------------------------------------------------
// Prompts (all Jev wording; identical to scout-0.3.1)
// ---------------------------------------------------------------------------

export const PROMPTS = {
  fileTask:
    "Code search triage for a software repository. A developer asked `question`. `files` lists candidate files found by keyword search; each entry is the file path followed by up to 3 matching lines as `line: text`. Judge each file independently by its path and matching lines.",
  fileCriteria: {
    yes: "Reading this file would likely help answer the question: it probably implements, decides, computes, configures, enforces or documents the asked behavior. A doc or design note that explains the behavior counts.",
    no: "The file probably only mentions the same words, imports or passes values through, belongs to an unrelated feature that shares keywords, or is a test that is not about the asked behavior.",
  },
  fileQuestion: (id: string, path: string, q: string) =>
    `Would reading file \`files.${id}\` (${path}) help answer the question${q}? Apply \`criteria\`.`,
  fileQuestionPerQ: (id: string, path: string, q: string) =>
    `Would reading file \`files.${id}\` (${path}) help answer the question${q}?`,

  passageTask:
    "Evidence check for a question about a software repository. Each entry in `passages` is a verbatim excerpt of one repository file with its original line numbers (`N| text`). `in` names the enclosing declaration when the excerpt starts inside one. Judge each passage on its own content only.",
  passageQuestion: (id: string, path: string, a: number, b: number, q: string) =>
    `Does \`passages.${id}\` (${path} lines ${a}-${b}) contain code or text needed to answer the question${q}?`,
  passageCriteria: {
    true: "The passage implements, decides, computes, configures, enforces or documents part of the asked behavior. A helper that performs one asked step counts, and so does a doc passage that states the behavior.",
    false:
      "The passage only mentions, imports, calls or passes through names related to the question, is a test or type declaration that does not show the behavior, or is unrelated code that shares keywords.",
  },
  coverageQuestion: (id: string, path: string, a: number, b: number, sub: string) =>
    `Does \`passages.${id}\` (${path} lines ${a}-${b}) show the answer to this part of the question: "${sub}"?`,
  coverageCriteria: {
    true: "The passage itself states or implements the answer to this part.",
    false:
      "The passage does not address this part, or only mentions it without showing the answer.",
  },

  leadTask:
    "Follow-up selection for a question about a software repository. Evidence passages already found reference the identifiers in `leads`, whose definitions have not been read yet. Each lead shows the identifier, where it was seen, and the line it appears on.",
  leadCriteria: {
    yes: "The definition likely computes, decides, configures or enforces part of the asked behavior, or holds a constant, setting or rule that the answer depends on.",
    no: "It is a generic helper (logging, formatting, errors, type plumbing, database or HTTP plumbing) or it is unrelated to the question.",
  },
  leadQuestion: (id: string, name: string, q: string) =>
    `Would reading where \`${name}\` (\`leads.${id}\`) is defined help answer the question${q}? Apply \`criteria\`.`,

  statusTask:
    "Sufficiency check. `evidence` is a set of verbatim excerpts of repository files (with original line numbers) collected to answer `question`.",
  statusQuestion: (q: string) =>
    `Do the \`evidence\` passages show the answer to the question${q}?`,
  statusSubQuestion: (sub: string) =>
    `Do the \`evidence\` passages show the answer to this part of the question: "${sub}"?`,
  statusCriteria: {
    true: "Together the passages state or implement the answer concretely enough to cite file and line.",
    false:
      "Some part of the answer is missing: the passages only mention the topic, or the deciding code is elsewhere.",
  },
};

function inlineQ(question: string, maxChars: number): string {
  return question.length <= maxChars ? `: "${question}"` : " in `question`";
}

function withSubs(ctx: JudgeContext): Record<string, unknown> {
  return ctx.subQuestions.length
    ? { sub_questions: Object.fromEntries(ctx.subQuestions.map((s, i) => [`s${i + 1}`, s])) }
    : {};
}

// ---------------------------------------------------------------------------
// Request builders (exported for tests)
// ---------------------------------------------------------------------------

export function buildFileRequest(items: FileItem[], ctx: JudgeContext, cfg: CodeSearchConfig) {
  const q = inlineQ(ctx.question, cfg.jev.inlineQuestionMaxChars);
  // default: the rubric is stated once in the state and referenced (~65% fewer question tokens);
  // fileCriteriaPerQuestion puts it on every Noul instead
  const perQ = cfg.jev.fileCriteriaPerQuestion;
  const state = {
    task: PROMPTS.fileTask,
    question: ctx.question,
    ...withSubs(ctx),
    ...(perQ ? {} : { criteria: PROMPTS.fileCriteria }),
    files: Object.fromEntries(items.map((f) => [f.id, f.descriptor])),
  };
  const questions: Record<string, JevNoulQuestion> = Object.fromEntries(
    items.map((f) => [
      f.id,
      perQ
        ? noul(PROMPTS.fileQuestionPerQ(f.id, f.path, q), {
            true: PROMPTS.fileCriteria.yes,
            false: PROMPTS.fileCriteria.no,
          })
        : noul(PROMPTS.fileQuestion(f.id, f.path, q)),
    ]),
  );
  return { state, questions };
}

export function buildPassageRequest(
  items: PassageItem[],
  ctx: JudgeContext,
  cfg: CodeSearchConfig,
) {
  const q = inlineQ(ctx.question, cfg.jev.inlineQuestionMaxChars);
  const state = {
    task: PROMPTS.passageTask,
    question: ctx.question,
    ...withSubs(ctx),
    passages: Object.fromEntries(
      items.map((p) => [
        p.id,
        {
          file: p.path,
          lines: `${p.start}-${p.end}`,
          ...(p.label ? { in: p.label } : {}),
          text: p.text,
        },
      ]),
    ),
  };
  const questions: Record<string, JevNoulQuestion> = {};
  for (const p of items) {
    questions[`rel::${p.id}`] = noul(
      PROMPTS.passageQuestion(p.id, p.path, p.start, p.end, q),
      PROMPTS.passageCriteria,
    );
    ctx.subQuestions.forEach((sub, j) => {
      questions[`cov::${p.id}::${j}`] = noul(
        PROMPTS.coverageQuestion(p.id, p.path, p.start, p.end, sub),
        PROMPTS.coverageCriteria,
      );
    });
  }
  return { state, questions };
}

export function buildLeadRequest(items: LeadItem[], ctx: JudgeContext, cfg: CodeSearchConfig) {
  const q = inlineQ(ctx.question, cfg.jev.inlineQuestionMaxChars);
  const state = {
    task: PROMPTS.leadTask,
    question: ctx.question,
    ...withSubs(ctx),
    criteria: PROMPTS.leadCriteria,
    leads: Object.fromEntries(
      items.map((l) => [l.id, `${l.name}  (seen at ${l.seenAt})  ${l.context}`]),
    ),
  };
  const questions: Record<string, JevNoulQuestion> = Object.fromEntries(
    items.map((l) => [l.id, noul(PROMPTS.leadQuestion(l.id, l.name, q))]),
  );
  return { state, questions };
}

export function buildStatusRequest(evidence: string, ctx: JudgeContext, cfg: CodeSearchConfig) {
  const q = inlineQ(ctx.question, cfg.jev.inlineQuestionMaxChars);
  const state = { task: PROMPTS.statusTask, question: ctx.question, ...withSubs(ctx), evidence };
  const questions: Record<string, JevNoulQuestion> = {
    overall: noul(PROMPTS.statusQuestion(q), PROMPTS.statusCriteria),
  };
  ctx.subQuestions.forEach((sub, j) => {
    questions[`sub::${j}`] = noul(PROMPTS.statusSubQuestion(sub), PROMPTS.statusCriteria);
  });
  return { state, questions };
}

/** Group passages into requests: consecutive (same-file first) up to perRequest items and maxChars of text. */
export function chunkPassages(
  items: PassageItem[],
  perRequest: number,
  maxChars: number,
): PassageItem[][] {
  const out: PassageItem[][] = [];
  let cur: PassageItem[] = [];
  let chars = 0;
  for (const p of items) {
    const c = p.text.length;
    if (cur.length && (cur.length >= perRequest || chars + c > maxChars)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(p);
    chars += c;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Split into the fewest groups of at most n items, as equal in size as possible (69 -> 35 + 34, not 60 + 9). */
export function chunkEven<T>(xs: T[], n: number): T[][] {
  if (!xs.length) return [];
  const groups = Math.ceil(xs.length / n);
  const size = Math.ceil(xs.length / groups);
  return chunk(xs, size);
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

const noulOf = (a: JevAnswer | undefined): number =>
  a && a.type === "noul" && Number.isFinite(a.probability) ? a.probability : Number.NaN;

function orLex(p: number, lex: number): number {
  return Number.isFinite(p) ? p : lex;
}

// ---------------------------------------------------------------------------
// Jev judge
// ---------------------------------------------------------------------------

export class JevJudge {
  private readonly stageStats: Record<string, StageStats> = {};
  private jevModel: string | null = null;

  constructor(
    private readonly o: {
      client: JevClient;
      config: CodeSearchConfig;
      signal: AbortSignal;
      onEvent?: JudgeEvent | undefined;
    },
  ) {}

  stats(): Record<string, StageStats> {
    return this.stageStats;
  }

  model(): string | null {
    return this.jevModel;
  }

  private stat(stage: string): StageStats {
    return (this.stageStats[stage] ??= { requests: 0, inputTokens: 0, costUsd: 0, ms: 0 });
  }

  /** One logical request (the client may split its questions into several HTTP requests). */
  private async ask(
    stage: string,
    state: unknown,
    questions: Record<string, JevNoulQuestion>,
  ): Promise<Record<string, JevAnswer>> {
    const t0 = performance.now();
    const r = await this.o.client.ask(state, questions, {
      tag: stage,
      signal: this.o.signal,
    });
    const st = this.stat(stage);
    st.requests += r.requests;
    st.inputTokens += r.usage.inputTokens;
    st.costUsd += r.costUsd;
    this.jevModel = r.model || this.jevModel;
    this.o.onEvent?.("jev", {
      jevStage: stage,
      ms: Math.round(performance.now() - t0),
      requests: r.requests,
      model: r.model,
      inputTokens: r.usage.inputTokens,
      costUsd: r.costUsd,
      state,
      questions,
      answers: r.answers,
    });
    return r.answers;
  }

  /** Run a stage's batches in parallel; the first failure rejects the stage. */
  private async stage<I, R>(
    stage: string,
    batches: I[][],
    build: (b: I[]) => { state: unknown; questions: Record<string, JevNoulQuestion> },
    read: (b: I[], answers: Record<string, JevAnswer>) => Array<[string, R]>,
  ): Promise<Map<string, R>> {
    const t0 = performance.now();
    try {
      const results = await Promise.all(
        batches.map(async (b) => {
          const req = build(b);
          return read(b, await this.ask(stage, req.state, req.questions));
        }),
      );
      return new Map(results.flat());
    } finally {
      this.stat(stage).ms += Math.round(performance.now() - t0);
    }
  }

  async scoreFiles(items: FileItem[], ctx: JudgeContext): Promise<Map<string, number>> {
    if (!items.length) return new Map();
    return this.stage(
      "wave1",
      chunkEven(items, this.o.config.wave1.filesPerRequest),
      (b) => buildFileRequest(b, ctx, this.o.config),
      (b, a) => b.map((f) => [f.id, orLex(noulOf(a[f.id]), f.lex)]),
    );
  }

  async scorePassages(
    items: PassageItem[],
    ctx: JudgeContext,
    stage = "wave2",
  ): Promise<Map<string, PassageScore>> {
    if (!items.length) return new Map();
    const w = this.o.config.wave2;
    return this.stage(
      stage,
      chunkPassages(items, w.passagesPerRequest, w.maxRequestChars),
      (b) => buildPassageRequest(b, ctx, this.o.config),
      (b, a) =>
        b.map((p) => [
          p.id,
          {
            rel: orLex(noulOf(a[`rel::${p.id}`]), p.lex),
            cov: ctx.subQuestions.map((_, j) =>
              orLex(noulOf(a[`cov::${p.id}::${j}`]), p.lexCov[j] ?? 0),
            ),
          },
        ]),
    );
  }

  async scoreLeads(items: LeadItem[], ctx: JudgeContext): Promise<Map<string, number>> {
    if (!items.length) return new Map();
    return this.stage(
      "leads",
      chunk(items, 250),
      (b) => buildLeadRequest(b, ctx, this.o.config),
      (b, a) => b.map((l) => [l.id, orLex(noulOf(a[l.id]), l.lex)]),
    );
  }

  /** null = nothing to check (empty evidence). */
  async status(evidence: string, ctx: JudgeContext): Promise<StatusScore | null> {
    if (!evidence.trim()) return null;
    const req = buildStatusRequest(evidence, ctx, this.o.config);
    const t0 = performance.now();
    try {
      const a = await this.ask("status", req.state, req.questions);
      return {
        overall: noulOf(a.overall),
        subs: ctx.subQuestions.map((_, j) => noulOf(a[`sub::${j}`])),
      };
    } finally {
      this.stat("status").ms += Math.round(performance.now() - t0);
    }
  }
}
