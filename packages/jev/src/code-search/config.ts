/**
 * Every code_search threshold, budget and cap in one place. The defaults are scout-0.3.1's Jev
 * configuration, tuned on the E1 DEV split (2026-09-24); change them only with a new evaluation.
 */

export interface CodeSearchConfig {
  recall: {
    /** Candidate files passed to wave 1. */
    maxCandidates: number;
    /** Matching lines kept per file per keyword. */
    maxMatchesPerFile: number;
    /** rg --max-filesize (bytes); also the read cap for candidate files. */
    maxFileBytes: number;
    /** rg --max-columns: lines longer than this (minified / generated / data blobs) are ignored entirely. */
    maxLineColumns: number;
    /** Multiplier for test files unless the question is about tests. */
    testWeight: number;
    /** Path-name match bonus as a fraction of the keyword's IDF. */
    pathBonus: number;
    /** Extra weight per log(1 + matching lines) (tie breaker). */
    hitCountWeight: number;
    /** Single plain words up to this length are searched with a leading word boundary (`\bturn`, not `return`). */
    shortWordMaxLen: number;
    /** Compound keywords with zero hits retry their 2-part fragments (e.g. shouldCompactContext -> compactContext). */
    fragmentFallback: boolean;
    /** If paths restrict the search and fewer candidates than this are found, widen to the whole workspace. */
    minCandidatesBeforeWiden: number;
    /** Extra rg exclude globs (on top of the built-in list). */
    extraExcludes: string[];
    /** Also search hidden files/dirs (.github/workflows, .env.example, .changeset); .git is always excluded. */
    searchHidden: boolean;
    /** Multiplier for release notes (CHANGELOG*, .changeset/) unless the question is about history/releases. */
    changelogWeight: number;
    /** Time limit per ripgrep call; a timed-out search continues with partial output. */
    ripgrepTimeoutMs: number;
  };
  wave1: {
    filesPerRequest: number;
    hitLinesPerFile: number;
    hitLineChars: number;
    /** Hard cap on files selected for windowing. */
    maxFiles: number;
    /** Always take at least this many files by judge score (guards against an over-strict T1). */
    minFiles: number;
    /** Always keep the top-N lexical files (fusion guard against judge misses). */
    lexicalGuard: number;
  };
  wave2: {
    windowsPerFile: number;
    /** How many of a file's strongest hit lines seed windows (before merging/splitting). */
    seedHitsPerFile: number;
    /** Max lines to walk up from a hit looking for the enclosing declaration. */
    maxUp: number;
    /** Max lines below a hit kept in its window. */
    maxDown: number;
    /** Windows longer than this are split around hit clusters. */
    maxWindowLines: number;
    /** Fallback context when no enclosing declaration is found within maxUp. */
    fallbackBefore: number;
    fallbackAfter: number;
    /** Merge windows whose gap is at most this many lines. */
    mergeGap: number;
    /** Windows shorter than this get surrounding context. */
    minWindowLines: number;
    passagesPerRequest: number;
    /** Max passage text chars per Jev request. */
    maxRequestChars: number;
    /** Max passages verified in wave 2. */
    maxPassages: number;
    /** Code lines longer than this are cut with an explicit marker. */
    maxLineChars: number;
    /** Same for prose files (md/mdx/txt/rst), which often have single-line paragraphs of 1-6k chars. */
    maxProseLineChars: number;
    /** Windows whose rendered text is longer are split into whole-line sub-windows around their hits. */
    maxWindowChars: number;
    /** Same for markdown (sections are long, paragraphs independent). */
    maxProseWindowChars: number;
  };
  wave3: {
    enabled: boolean;
    maxLeadCandidates: number;
    maxLeadsFollowed: number;
    /** Leads are extracted from at most this many of the most relevant passages (all >= T2). */
    seedPassages: number;
    defsPerLead: number;
  };
  status: {
    enabled: boolean;
    /** Max evidence chars sent to the status check (best passages first); keeps the request under Jev's 32k-token limit. */
    maxEvidenceChars: number;
    /** sufficient: overall >= hi and every sub-question >= hi. */
    hi: number;
    /** partial: overall >= lo or any sub-question >= hi. */
    lo: number;
  };
  pack: {
    charsPerToken: number;
    /** Include passages below T2 only if fewer than this many passed (top by score, above minRelevance). */
    minPassages: number;
    minRelevance: number;
    /** Fill the remaining budget with passages below T2 (ranked). */
    fillBudget: boolean;
    moreCandidates: number;
    leadsNotFollowed: number;
    /** A trimmed passage must keep at least this many lines. */
    minTrimLines: number;
    /** File-diversity penalty: a second passage of one file must beat the first passage of another by this margin. */
    filePenalty: number;
    /** Passages whose rendered block is longer are trimmed around their hits to this many chars (0 = off). */
    maxPassageChars: number;
    /** Multiplier on the rel used for pack ORDERING of release-note passages; 1 = off. */
    changelogPrior: number;
    /** Same for prose docs (md/mdx/txt/rst, not release notes); 1 = off. */
    docPrior: number;
    /** Same for test files unless the question is about tests; 1 = off. */
    testPrior: number;
    /** Pack ordering score = (rel + lexWeight x lexical passage score) x prior. */
    lexWeight: number;
  };
  jev: {
    /** Inline the question text in every Jev question when it is at most this long; else reference `question`. */
    inlineQuestionMaxChars: number;
    /** Wave 1: put the true/false rubric on every file question instead of once in the state. */
    fileCriteriaPerQuestion: boolean;
    /** Keep-alive connections opened while recall runs (0 = off). */
    warmConnections: number;
  };
  thresholds: {
    /** Wave 1: file triage floor (p >= T1 selects, up to maxFiles). */
    T1: number;
    /** Wave 2: passage relevance floor for inclusion in the pack, lead seeding and sub-question coverage. */
    T2: number;
    /** Wave 3: lead floor (p >= T3 is followed, up to maxLeadsFollowed). */
    T3: number;
  };
}

export type CodeSearchConfigOverride = {
  [K in keyof CodeSearchConfig]?: Partial<CodeSearchConfig[K]>;
};

export const DEFAULT_CODE_SEARCH_CONFIG: Readonly<CodeSearchConfig> = deepFreeze({
  recall: {
    maxCandidates: 240,
    maxMatchesPerFile: 25,
    maxFileBytes: 4_000_000,
    maxLineColumns: 8000,
    testWeight: 0.6,
    pathBonus: 0.5,
    hitCountWeight: 0.1,
    shortWordMaxLen: 5,
    fragmentFallback: true,
    minCandidatesBeforeWiden: 5,
    extraExcludes: [],
    searchHidden: true,
    changelogWeight: 0.6,
    ripgrepTimeoutMs: 30_000,
  },
  wave1: {
    filesPerRequest: 60,
    hitLinesPerFile: 3,
    hitLineChars: 160,
    maxFiles: 16,
    minFiles: 8,
    lexicalGuard: 5,
  },
  wave2: {
    windowsPerFile: 5,
    seedHitsPerFile: 24,
    maxUp: 40,
    maxDown: 120,
    maxWindowLines: 150,
    fallbackBefore: 10,
    fallbackAfter: 30,
    mergeGap: 2,
    minWindowLines: 12,
    passagesPerRequest: 4,
    maxRequestChars: 24_000,
    maxPassages: 80,
    maxLineChars: 400,
    maxProseLineChars: 1600,
    maxWindowChars: 8000,
    maxProseWindowChars: 4000,
  },
  wave3: {
    enabled: true,
    maxLeadCandidates: 60,
    maxLeadsFollowed: 6,
    seedPassages: 12,
    defsPerLead: 1,
  },
  status: { enabled: true, maxEvidenceChars: 60_000, hi: 0.7, lo: 0.4 },
  pack: {
    charsPerToken: 3.2,
    minPassages: 4,
    minRelevance: 0.1,
    fillBudget: false,
    moreCandidates: 10,
    leadsNotFollowed: 8,
    minTrimLines: 15,
    filePenalty: 0.1,
    maxPassageChars: 3200,
    changelogPrior: 0.5,
    docPrior: 0.85,
    testPrior: 1,
    lexWeight: 0,
  },
  jev: {
    inlineQuestionMaxChars: 600,
    fileCriteriaPerQuestion: false,
    warmConnections: 12,
  },
  // calibrated on the DEV split from the observed score distributions (relevant files mostly 0.6-0.9;
  // minFiles and the lexical guard keep recall when few files pass)
  thresholds: { T1: 0.6, T2: 0.5, T3: 0.5 },
});

/** Defaults with a partial override merged on top (unknown keys and wrong types are rejected), validated. */
export function codeSearchConfig(override: CodeSearchConfigOverride = {}): CodeSearchConfig {
  const base = structuredClone(DEFAULT_CODE_SEARCH_CONFIG) as CodeSearchConfig;
  const out = base as unknown as Record<string, Record<string, unknown>>;
  for (const [section, values] of Object.entries(override as Record<string, unknown>)) {
    const target = out[section];
    if (!target) throw new Error(`unknown code_search config section: ${section}`);
    if (!isPlainObject(values)) throw new Error(`code_search config ${section}: expected object`);
    for (const [key, value] of Object.entries(values)) {
      if (!(key in target)) throw new Error(`unknown code_search config key: ${section}.${key}`);
      const current = target[key];
      if (Array.isArray(current) ? !Array.isArray(value) : typeof current !== typeof value) {
        throw new Error(
          `code_search config ${section}.${key}: expected ${Array.isArray(current) ? "array" : typeof current}`,
        );
      }
      target[key] = value;
    }
  }
  validateCodeSearchConfig(base);
  return base;
}

export function validateCodeSearchConfig(c: CodeSearchConfig): void {
  const probs: string[] = [];
  for (const [k, v] of Object.entries(c.thresholds))
    if (!(v >= 0 && v <= 1)) probs.push(`thresholds.${k} must be in [0,1]`);
  if (c.wave1.maxFiles < 1) probs.push("wave1.maxFiles must be >= 1");
  if (c.wave1.minFiles > c.wave1.maxFiles) probs.push("wave1.minFiles must be <= wave1.maxFiles");
  if (c.wave1.filesPerRequest < 1 || c.wave1.filesPerRequest > 250)
    probs.push("wave1.filesPerRequest must be 1..250");
  if (c.wave2.passagesPerRequest < 1) probs.push("wave2.passagesPerRequest must be >= 1");
  if (c.wave2.maxWindowLines < 10) probs.push("wave2.maxWindowLines must be >= 10");
  if (c.wave2.maxWindowChars < 4 * c.wave2.maxLineChars)
    probs.push("wave2.maxWindowChars must be >= 4 x wave2.maxLineChars");
  if (c.wave2.maxProseWindowChars < 2 * c.wave2.maxProseLineChars + 200) {
    probs.push("wave2.maxProseWindowChars must be >= 2 x wave2.maxProseLineChars + 200");
  }
  if (c.wave3.maxLeadCandidates > 250) probs.push("wave3.maxLeadCandidates must be <= 250");
  if (!(c.status.lo <= c.status.hi)) probs.push("status.lo must be <= status.hi");
  if (c.pack.charsPerToken <= 0) probs.push("pack.charsPerToken must be > 0");
  if (c.pack.filePenalty < 0) probs.push("pack.filePenalty must be >= 0");
  if (c.pack.maxPassageChars !== 0 && c.pack.maxPassageChars < 600)
    probs.push("pack.maxPassageChars must be 0 or >= 600");
  for (const k of ["changelogPrior", "docPrior", "testPrior"] as const) {
    if (!(c.pack[k] > 0 && c.pack[k] <= 1)) probs.push(`pack.${k} must be in (0,1]`);
  }
  if (!(c.pack.lexWeight >= 0)) probs.push("pack.lexWeight must be >= 0");
  if (!(c.recall.changelogWeight > 0 && c.recall.changelogWeight <= 1))
    probs.push("recall.changelogWeight must be in (0,1]");
  if (!(c.recall.ripgrepTimeoutMs > 0)) probs.push("recall.ripgrepTimeoutMs must be > 0");
  if (probs.length) throw new Error(`invalid code_search config: ${probs.join("; ")}`);
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
