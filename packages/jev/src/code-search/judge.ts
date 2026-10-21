/**
 * judge.ts - the only place where scores come from: a typed model returns a probability per item.
 *
 * All judge wording lives in PROMPTS below (one place to review). Design rules followed:
 *  - one state + many narrow predicates per request; one predicate per candidate
 *  - criteria text is explicit (in the state for 60-file triage batches, per question for passages)
 *  - the literal question text is inlined in every question (no `collections[i]`-style indirection)
 *  - state holds only the candidates being judged (filtered by code first)
 *  - no counting, math or dates asked of the model; code combines answers
 * A model failure or refusal is not replaced by lexical scores.
 */
import {
  predicate,
  DecisionUnavailableError,
  type DecisionAnswer,
  type DecisionModel,
  type DecisionPredicateQuestion,
  type DecisionUsage,
} from "@opengeni/decisions";
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
  /** Normalized lexical score retained for candidate ordering. */
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
  inputTokens: number | null;
  costUsd: number | null;
  ms: number;
}

export type JudgeEvent = (stage: string, data: Record<string, unknown>) => void;

// ---------------------------------------------------------------------------
// Prompts (judge wording retained from scout-0.3.1)
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

  symbolTask:
    "Symbol follow-up for a question about a software repository. Files already judged relevant declare, import, call or render the identifiers in `symbols`. Each entry shows the identifier and one place it occurs. Reading its definition or the other places that use it may reveal code the question depends on (the implementation behind an import, other callers of a function, sibling code paths that must change together).",
  symbolCriteria: {
    yes: "Its definition or its other usages likely implement, decide, configure or must change together with the asked behavior (for example the hook or function behind the data, other places that mutate the same state, or other entry points to the same outcome).",
    no: "It is a generic helper, UI primitive, type plumbing, logging, formatting or error handling, or it is unrelated to the question.",
  },
  symbolQuestion: (id: string, name: string, q: string) =>
    `Would reading where \`${name}\` (\`symbols.${id}\`) is defined or used help answer the question${q}? Apply \`criteria\`.`,

  changeTask:
    "Change planning for a request about a software repository. A developer asked `question`. `declarations` lists functions, handlers, hooks and components declared in files already judged relevant, each with where it is declared and its first lines. Beyond the code that directly answers the question, a correct change often has to touch or re-check sibling code: other places that mutate or invalidate the same state, other entry points to the same outcome, callers that must pass something new.",
  changeCriteria: {
    yes: "A correct answer or change must also read or change this declaration: it mutates, invalidates, produces or consumes the same state or data, it is another entry point or sibling path for the same behavior, or it is where the change itself goes.",
    no: "It is unrelated to the asked behavior, or it is a generic helper, formatting or UI plumbing that the change would not touch.",
  },
  changeQuestion: (id: string, name: string, q: string) =>
    `Must a developer who answers or implements the question${q} also read or change \`${name}\` (\`declarations.${id}\`)? Apply \`criteria\`.`,

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
  const questions: Record<string, DecisionPredicateQuestion> = Object.fromEntries(
    items.map((f) => [
      f.id,
      perQ
        ? predicate(PROMPTS.fileQuestionPerQ(f.id, f.path, q), {
            true: PROMPTS.fileCriteria.yes,
            false: PROMPTS.fileCriteria.no,
          })
        : predicate(PROMPTS.fileQuestion(f.id, f.path, q)),
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
  const questions: Record<string, DecisionPredicateQuestion> = {};
  for (const p of items) {
    questions[`rel::${p.id}`] = predicate(
      PROMPTS.passageQuestion(p.id, p.path, p.start, p.end, q),
      PROMPTS.passageCriteria,
    );
    ctx.subQuestions.forEach((sub, j) => {
      questions[`cov::${p.id}::${j}`] = predicate(
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
  const questions: Record<string, DecisionPredicateQuestion> = Object.fromEntries(
    items.map((l) => [l.id, predicate(PROMPTS.leadQuestion(l.id, l.name, q))]),
  );
  return { state, questions };
}

export function buildSymbolRequest(items: LeadItem[], ctx: JudgeContext, cfg: CodeSearchConfig) {
  const q = inlineQ(ctx.question, cfg.jev.inlineQuestionMaxChars);
  const state = {
    task: PROMPTS.symbolTask,
    question: ctx.question,
    ...withSubs(ctx),
    criteria: PROMPTS.symbolCriteria,
    symbols: Object.fromEntries(items.map((l) => [l.id, `${l.name}  (${l.context})`])),
  };
  const questions: Record<string, DecisionPredicateQuestion> = Object.fromEntries(
    items.map((l) => [l.id, predicate(PROMPTS.symbolQuestion(l.id, l.name, q))]),
  );
  return { state, questions };
}

export function buildChangeRequest(items: LeadItem[], ctx: JudgeContext, cfg: CodeSearchConfig) {
  const q = inlineQ(ctx.question, cfg.jev.inlineQuestionMaxChars);
  const state = {
    task: PROMPTS.changeTask,
    question: ctx.question,
    ...withSubs(ctx),
    criteria: PROMPTS.changeCriteria,
    declarations: Object.fromEntries(
      items.map((l) => [l.id, `${l.name}  (${l.seenAt})\n${l.context}`]),
    ),
  };
  const questions: Record<string, DecisionPredicateQuestion> = Object.fromEntries(
    items.map((l) => [l.id, predicate(PROMPTS.changeQuestion(l.id, l.name, q))]),
  );
  return { state, questions };
}

export function buildStatusRequest(evidence: string, ctx: JudgeContext, cfg: CodeSearchConfig) {
  const q = inlineQ(ctx.question, cfg.jev.inlineQuestionMaxChars);
  const state = { task: PROMPTS.statusTask, question: ctx.question, ...withSubs(ctx), evidence };
  const questions: Record<string, DecisionPredicateQuestion> = {
    overall: predicate(PROMPTS.statusQuestion(q), PROMPTS.statusCriteria),
  };
  ctx.subQuestions.forEach((sub, j) => {
    questions[`sub::${j}`] = predicate(PROMPTS.statusSubQuestion(sub), PROMPTS.statusCriteria);
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

const probabilityOf = (a: DecisionAnswer | undefined): number =>
  a && a.type === "predicate" && Number.isFinite(a.probability) ? a.probability : Number.NaN;

function orLex(p: number, lex: number): number {
  return Number.isFinite(p) ? p : lex;
}

// ---------------------------------------------------------------------------
// Provider-neutral judge
// ---------------------------------------------------------------------------

export class CodeSearchJudge {
  private readonly stageStats: Record<string, StageStats> = {};
  private decisionModelName: string | null = null;
  private decisionProvider: string | null = null;
  private readonly usageCostSources = new Set<"provider-reported" | "estimate" | "unknown">();

  constructor(
    private readonly o: {
      client: DecisionModel;
      config: CodeSearchConfig;
      signal: AbortSignal;
      onEvent?: JudgeEvent | undefined;
      onUsage?: ((usage: DecisionUsage) => void | Promise<void>) | undefined;
    },
  ) {}

  stats(): Record<string, StageStats> {
    return this.stageStats;
  }

  model(): string | null {
    return this.decisionModelName;
  }
  provider(): string | null {
    return this.decisionProvider;
  }
  costSources() {
    return [...this.usageCostSources];
  }

  private stat(stage: string): StageStats {
    return (this.stageStats[stage] ??= { requests: 0, inputTokens: 0, costUsd: 0, ms: 0 });
  }

  /** One logical request (the client may split its questions into several HTTP requests). */
  private async ask(
    stage: string,
    state: unknown,
    questions: Record<string, DecisionPredicateQuestion>,
  ): Promise<Record<string, DecisionAnswer>> {
    const t0 = performance.now();
    const r = await this.o.client.decide(state, questions, {
      tag: stage,
      signal: this.o.signal,
      onUsage: (usage) => {
        const st = this.stat(stage);
        st.requests += usage.requests;
        st.inputTokens =
          st.inputTokens === null || usage.inputTokens === null
            ? null
            : st.inputTokens + usage.inputTokens;
        st.costUsd =
          st.costUsd === null || usage.costUsd === null ? null : st.costUsd + usage.costUsd;
        this.decisionModelName = usage.model || this.decisionModelName;
        this.decisionProvider = usage.provider || this.decisionProvider;
        this.usageCostSources.add(usage.costSource);
        return this.o.onUsage?.(usage);
      },
    });
    for (const name of Object.keys(questions)) {
      const answer = r.answers[name];
      if (
        answer?.type !== "predicate" ||
        !Number.isFinite(answer.probability) ||
        answer.probability < 0 ||
        answer.probability > 1
      )
        throw new DecisionUnavailableError(
          "Code-search decision model returned an invalid judgment or refusal",
        );
    }
    this.o.onEvent?.("decision", {
      decisionStage: stage,
      ms: Math.round(performance.now() - t0),
      ...r.usage,
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
    build: (b: I[]) => { state: unknown; questions: Record<string, DecisionPredicateQuestion> },
    read: (b: I[], answers: Record<string, DecisionAnswer>) => Array<[string, R]>,
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
      (b, a) => b.map((f) => [f.id, orLex(probabilityOf(a[f.id]), f.lex)]),
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
            rel: orLex(probabilityOf(a[`rel::${p.id}`]), p.lex),
            cov: ctx.subQuestions.map((_, j) =>
              orLex(probabilityOf(a[`cov::${p.id}::${j}`]), p.lexCov[j] ?? 0),
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
      (b, a) => b.map((l) => [l.id, orLex(probabilityOf(a[l.id]), l.lex)]),
    );
  }

  async scoreSymbols(items: LeadItem[], ctx: JudgeContext): Promise<Map<string, number>> {
    if (!items.length) return new Map();
    return this.stage(
      "symbols",
      chunkEven(items, 120),
      (b) => buildSymbolRequest(b, ctx, this.o.config),
      (b, a) => b.map((l) => [l.id, orLex(probabilityOf(a[l.id]), l.lex)]),
    );
  }

  async scoreChange(items: LeadItem[], ctx: JudgeContext): Promise<Map<string, number>> {
    if (!items.length) return new Map();
    return this.stage(
      "change",
      chunkEven(items, 80),
      (b) => buildChangeRequest(b, ctx, this.o.config),
      (b, a) => b.map((l) => [l.id, orLex(probabilityOf(a[l.id]), 0)]),
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
        overall: probabilityOf(a.overall),
        subs: ctx.subQuestions.map((_, j) => probabilityOf(a[`sub::${j}`])),
      };
    } finally {
      this.stat("status").ms += Math.round(performance.now() - t0);
    }
  }
}
