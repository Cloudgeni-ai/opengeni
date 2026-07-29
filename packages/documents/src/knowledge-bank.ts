// Knowledge-bank charter synthesis: the LLM (or deterministic heuristic) that
// turns the structural knowledge map + recent signals into the next charter
// version. Mirrors the document-curation provider pattern in ./index.ts:
// pluggable port, OpenAI-backed default, heuristic fallback so a synthesis
// failure can never block the bank from updating.
import type { Settings } from "@opengeni/config";
import type { KnowledgeMap, WorkspaceCharter, WorkspaceCharterBaseNote } from "@opengeni/contracts";
import {
  aggregateKnowledgeMap,
  gatherCharterSynthesisSignals,
  getKnowledgeBankState,
  getLatestWorkspaceCharter,
  recordKnowledgeBankSweepResult,
  saveWorkspaceCharterVersion,
  type Database,
} from "@opengeni/db";
import OpenAI from "openai";
import { documentOpenAIEmbeddingConfig } from "./index";

export const DEFAULT_KNOWLEDGE_BANK_MODEL = "gpt-4o-mini";

export type CharterSynthesisInput = {
  /** The latest charter, or null when synthesizing the first version. */
  currentCharter: Pick<
    WorkspaceCharter,
    "purpose" | "goals" | "overview" | "gaps" | "version"
  > | null;
  map: KnowledgeMap;
  recentDocuments: Array<{ title: string; summary: string | null; topics: string[] }>;
  recentMemories: Array<{ kind: string; text: string }>;
};

export type CharterSynthesisOutcome = {
  purpose: string;
  goals: string[];
  overview: string | null;
  baseNotes: WorkspaceCharterBaseNote[];
  gaps: string[];
  changelog: string;
};

export type CharterSynthesizer = {
  model: string;
  synthesize: (input: CharterSynthesisInput) => Promise<CharterSynthesisOutcomeParsed>;
};

// The parsed outcome keeps base notes keyed by name; the caller resolves ids.
export type CharterSynthesisOutcomeParsed = Omit<CharterSynthesisOutcome, "baseNotes"> & {
  baseNotes: Array<{ name: string; blurb: string }>;
};

/**
 * Deterministic no-network synthesis: preserves human-authored purpose/goals,
 * derives the overview and per-base notes from the structural map, and reports
 * charter goals whose words never appear in the topic set as gaps. Used as the
 * `heuristic` provider and as the in-sweep fallback when the LLM fails.
 */
export function heuristicCharterSynthesis(
  input: CharterSynthesisInput,
): CharterSynthesisOutcomeParsed {
  const topTopics = input.map.topics.slice(0, 8).map((entry) => entry.topic);
  const purpose =
    input.currentCharter?.purpose ??
    (topTopics.length > 0
      ? `This workspace collects and organizes knowledge about ${topTopics.slice(0, 5).join(", ")}.`
      : "This workspace collects and organizes team knowledge. Drop documents and record memories to teach it its purpose.");
  const goals = input.currentCharter?.goals ?? [];
  const overview =
    input.map.totalDocuments > 0 || input.map.totalMemories > 0
      ? `${input.map.totalReadyDocuments} indexed documents across ${input.map.bases.length} ` +
        `${input.map.bases.length === 1 ? "base" : "bases"} and ${input.map.totalMemories} ` +
        `workspace memories.` +
        (topTopics.length > 0 ? ` Main topics: ${topTopics.join(", ")}.` : "")
      : null;
  const baseNotes = input.map.bases
    .filter((base) => base.documentCount > 0)
    .map((base) => ({
      name: base.name,
      blurb:
        `${base.readyCount} ${base.readyCount === 1 ? "document" : "documents"}` +
        (base.topics.length > 0 ? ` about ${base.topics.slice(0, 5).join(", ")}` : ""),
    }));
  const topicSet = new Set(input.map.topics.map((entry) => entry.topic));
  const gaps = goals
    .filter((goal) => {
      const words = goal.toLowerCase().match(/[a-z]{4,}/g) ?? [];
      return words.length > 0 && !words.some((word) => topicSet.has(word));
    })
    .map((goal) => `No indexed knowledge yet covering the goal: "${goal}"`)
    .slice(0, 4);
  return {
    purpose,
    goals,
    overview,
    baseNotes,
    gaps,
    changelog: `Refreshed knowledge map: ${input.map.totalReadyDocuments} documents, ${input.map.totalMemories} memories.`,
  };
}

export class HeuristicCharterSynthesizer implements CharterSynthesizer {
  readonly model = "heuristic";

  async synthesize(input: CharterSynthesisInput): Promise<CharterSynthesisOutcomeParsed> {
    return heuristicCharterSynthesis(input);
  }
}

const CHARTER_SYSTEM_PROMPT = [
  "You maintain a workspace's living charter — its purpose, current goals, and a map",
  "of what it knows. Given the current charter, the structural knowledge map, and",
  "recent documents/memories, return STRICT JSON with keys:",
  '"purpose" (1-3 sentences: what this workspace is for, inferred from the evidence;',
  "preserve the current purpose's intent unless the evidence clearly moved on),",
  '"goals" (3-8 short imperative goals the workspace is evidently pursuing; keep',
  "still-relevant current goals, retire stale ones),",
  '"overview" (2-4 sentences: what the workspace currently knows),',
  '"baseNotes" (array of {"name","blurb"} — one sentence per non-empty base),',
  '"gaps" (up to 4 short statements of knowledge the goals need but the map lacks),',
  '"changelog" (one sentence: what changed since the previous version).',
  "Never invent facts absent from the input. Respond with JSON only.",
].join(" ");

export class OpenAICharterSynthesizer implements CharterSynthesizer {
  private client: OpenAI | null = null;
  private readonly apiKey: string | undefined;
  private readonly baseURL: string | undefined;
  private readonly defaultHeaders: Record<string, string> | undefined;
  private readonly defaultQuery: Record<string, string> | undefined;
  readonly model: string;

  constructor(args: {
    apiKey?: string | undefined;
    baseURL?: string | undefined;
    defaultHeaders?: Record<string, string> | undefined;
    defaultQuery?: Record<string, string> | undefined;
    model?: string | undefined;
  }) {
    this.apiKey = args.apiKey ?? process.env.OPENAI_API_KEY;
    this.baseURL = args.baseURL;
    this.defaultHeaders = args.defaultHeaders;
    this.defaultQuery = args.defaultQuery;
    this.model = args.model ?? DEFAULT_KNOWLEDGE_BANK_MODEL;
  }

  async synthesize(input: CharterSynthesisInput): Promise<CharterSynthesisOutcomeParsed> {
    const response = await this.openai().chat.completions.create({
      model: this.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: CHARTER_SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            currentCharter: input.currentCharter,
            map: input.map,
            recentDocuments: input.recentDocuments,
            recentMemories: input.recentMemories,
          }),
        },
      ],
    });
    const raw = response.choices[0]?.message?.content;
    if (!raw) {
      throw new Error("charter synthesis model returned no content");
    }
    return parseCharterSynthesis(raw, input);
  }

  private openai(): OpenAI {
    if (!this.apiKey) {
      throw new Error("OpenAI knowledge-bank synthesis requires an API key");
    }
    this.client ??= new OpenAI({
      apiKey: this.apiKey,
      ...(this.baseURL ? { baseURL: this.baseURL } : {}),
      ...(this.defaultQuery ? { defaultQuery: this.defaultQuery } : {}),
      ...(this.defaultHeaders ? { defaultHeaders: this.defaultHeaders } : {}),
    });
    return this.client;
  }
}

/** Parse + clamp model output; malformed fields fall back to heuristic values. */
export function parseCharterSynthesis(
  raw: string,
  input: CharterSynthesisInput,
): CharterSynthesisOutcomeParsed {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("charter synthesis model returned non-object JSON");
  }
  const record = parsed as Record<string, unknown>;
  const fallback = heuristicCharterSynthesis(input);
  const cleanStrings = (value: unknown, maxItems: number, maxChars: number): string[] =>
    Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, maxItems)
          .map((item) => item.slice(0, maxChars))
      : [];
  const purpose =
    typeof record.purpose === "string" && record.purpose.trim()
      ? record.purpose.trim().slice(0, 2000)
      : fallback.purpose;
  const goals = cleanStrings(record.goals, 12, 300);
  const baseNotes = Array.isArray(record.baseNotes)
    ? record.baseNotes
        .filter(
          (note): note is { name: string; blurb: string } =>
            typeof note === "object" &&
            note !== null &&
            typeof (note as { name?: unknown }).name === "string" &&
            typeof (note as { blurb?: unknown }).blurb === "string",
        )
        .slice(0, 24)
        .map((note) => ({ name: note.name.slice(0, 200), blurb: note.blurb.slice(0, 500) }))
    : fallback.baseNotes;
  return {
    purpose,
    goals: goals.length > 0 ? goals : fallback.goals,
    overview:
      typeof record.overview === "string" && record.overview.trim()
        ? record.overview.trim().slice(0, 4000)
        : fallback.overview,
    baseNotes,
    gaps: cleanStrings(record.gaps, 8, 300),
    changelog:
      typeof record.changelog === "string" && record.changelog.trim()
        ? record.changelog.trim().slice(0, 500)
        : fallback.changelog,
  };
}

export type SynthesizeKnowledgeBankResult = {
  charter: WorkspaceCharter | null;
  skipped: "locked" | "disabled" | null;
  model: string | null;
  fallback: boolean;
};

/**
 * One full bank refresh for one workspace: aggregate the structural map,
 * gather recent signals, synthesize the next charter (LLM with heuristic
 * fallback — synthesis can never fail the refresh), persist it, and settle
 * sweep state. Shared by the background sweep and the API's inline refresh.
 * A locked bank or `none` provider records a clean sweep without writing.
 */
export async function synthesizeKnowledgeBank(
  db: Database,
  settings: Settings | undefined,
  input: { accountId: string; workspaceId: string; updatedBy: string },
): Promise<SynthesizeKnowledgeBankResult> {
  const synthesizer = createCharterSynthesizer(settings);
  if (!synthesizer) {
    await recordKnowledgeBankSweepResult(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
    });
    return { charter: null, skipped: "disabled", model: null, fallback: false };
  }
  const state = await getKnowledgeBankState(db, input.workspaceId);
  if (state?.locked) {
    await recordKnowledgeBankSweepResult(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
    });
    return { charter: null, skipped: "locked", model: null, fallback: false };
  }
  const [currentCharter, map, signals] = await Promise.all([
    getLatestWorkspaceCharter(db, input.workspaceId),
    aggregateKnowledgeMap(db, input.workspaceId),
    gatherCharterSynthesisSignals(db, input.workspaceId),
  ]);
  const synthesisInput: CharterSynthesisInput = {
    currentCharter,
    map,
    recentDocuments: signals.recentDocuments,
    recentMemories: signals.recentMemories,
  };
  let outcome: CharterSynthesisOutcomeParsed;
  let model = synthesizer.model;
  let fallback = false;
  try {
    outcome = await synthesizer.synthesize(synthesisInput);
  } catch (error) {
    fallback = true;
    model = "heuristic";
    console.warn("knowledge-bank synthesis failed; applying heuristic fallback", {
      workspaceId: input.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    outcome = heuristicCharterSynthesis(synthesisInput);
  }
  const baseIdsByName = new Map(map.bases.map((base) => [base.name.toLowerCase(), base.id]));
  const charter = await saveWorkspaceCharterVersion(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    purpose: outcome.purpose,
    goals: outcome.goals,
    overview: outcome.overview,
    baseNotes: outcome.baseNotes.map((note) => ({
      baseId: baseIdsByName.get(note.name.toLowerCase()) ?? null,
      name: note.name,
      blurb: note.blurb,
    })),
    gaps: outcome.gaps,
    changelog: outcome.changelog,
    updatedBy: input.updatedBy,
    model,
  });
  await recordKnowledgeBankSweepResult(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
  });
  return { charter, skipped: null, model, fallback };
}

export function createCharterSynthesizer(settings?: Settings): CharterSynthesizer | undefined {
  const provider = settings?.knowledgeBankProvider ?? "openai";
  if (provider === "none") return undefined;
  if (provider === "heuristic") return new HeuristicCharterSynthesizer();
  const embeddingConfig = documentOpenAIEmbeddingConfig(settings);
  return new OpenAICharterSynthesizer({
    apiKey: settings?.knowledgeBankApiKey ?? embeddingConfig.apiKey,
    baseURL: settings?.knowledgeBankBaseUrl ?? embeddingConfig.baseURL,
    defaultHeaders: embeddingConfig.defaultHeaders,
    defaultQuery: embeddingConfig.defaultQuery,
    model: settings?.knowledgeBankModel ?? DEFAULT_KNOWLEDGE_BANK_MODEL,
  });
}
