import type { Tool } from "@openai/agents";

const STOPWORDS = new Set(
  "a an the and or of to in on for with by at is are be do does my me your you it its this that from as up out all some any can will would should want need please user users another existing current".split(
    " ",
  ),
);

/** Normalize inflections symmetrically (schedule/scheduled, create/creating). */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) word = `${word.slice(0, -3)}y`;
  else if (word.length > 4 && /(?:sses|xes|ches|shes)$/.test(word)) word = word.slice(0, -2);
  else if (word.length > 3 && word.endsWith("s") && !/(?:ss|us|is)$/.test(word))
    word = word.slice(0, -1);
  if (word.length > 5 && word.endsWith("ing")) {
    word = word.slice(0, -3);
    if (/([b-df-hj-np-tv-z])\1$/.test(word)) word = word.slice(0, -1);
  } else if (word.length > 4 && word.endsWith("ed")) word = word.slice(0, -2);
  if (word.length > 3 && word.endsWith("e")) word = word.slice(0, -1);
  return word;
}

function words(text: string): string[] {
  return text
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w) && !/^[a-f0-9]{16,}$/.test(w))
    .map(stem);
}

// Generic operation vocabulary, not per-tool aliases. Exact words retain greater
// weight than expansions; an expansion alone must never drown out the resource.
const OPERATIONS = [
  "get read retrieve fetch inspect show view",
  "list browse enumerate",
  "search find lookup",
  "create make add insert spawn",
  "update edit change set modify configure save",
  "delete remove destroy",
  "pause stop halt",
  "resume continue unpause",
  "send post deliver",
  "run execute trigger",
].map((group) => new Set(words(group)));
const GENERIC_QUERY_TERMS = new Set(words("tool capability operation details available"));
const isResourceTerm = (token: string) =>
  !OPERATIONS.some((group) => group.has(token)) && !GENERIC_QUERY_TERMS.has(token);

type Field = { frequencies: Map<string, number>; length: number };
type Document = {
  tool: Tool;
  fields: Field[];
  terms: Set<string>;
  operation: Set<string> | undefined;
  resources: string[];
};

function field(text: string): Field {
  const tokens = words(text);
  const frequencies = new Map<string, number>();
  for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  return { frequencies, length: tokens.length };
}

function document(tool: Tool): Document {
  if (tool.type !== "function") throw new Error("Only function tools are searchable");
  // Transport routing hashes are not capability words. Keep readable namespaces.
  const separator = tool.name.lastIndexOf("__");
  const name = separator < 0 ? tool.name : tool.name.slice(separator + 2);
  const description = tool.description ?? "";
  const lead = description.split(/(?<=[.!?])\s|\n/, 1)[0] ?? "";
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties;
  const fields = [
    field(name),
    field(lead),
    field(description.slice(lead.length)),
    field(Object.keys(properties ?? {}).join(" ")),
  ];
  const nameWords = words(name);
  const operationWord = [nameWords[0], nameWords.at(-1), ...nameWords].find(
    (word) => word && OPERATIONS.some((group) => group.has(word)),
  );
  return {
    tool,
    fields,
    terms: new Set(fields.flatMap((f) => [...f.frequencies.keys()])),
    operation: OPERATIONS.find((group) => operationWord && group.has(operationWord)),
    resources: [...new Set(nameWords.filter(isResourceTerm))],
  };
}

/**
 * Field-aware BM25: names and the capability sentence are not length-penalized
 * by long operational guidance or schemas. No provider call or external index.
 * The index belongs to this exact authorized pool, never a global tool registry.
 */
export class ToolSearchIndex {
  private readonly documents: Document[];
  private readonly documentFrequency = new Map<string, number>();
  private readonly averageLengths: number[];

  constructor(tools: readonly Tool[]) {
    this.documents = tools.filter((t) => t.type === "function").map(document);
    for (const doc of this.documents) {
      for (const term of doc.terms)
        this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
    }
    this.averageLengths = [0, 1, 2, 3].map((i) =>
      Math.max(
        1,
        this.documents.reduce((sum, d) => sum + d.fields[i]!.length, 0) /
          Math.max(1, this.documents.length),
      ),
    );
  }

  rank(query: string, limit: number): Tool[] {
    // Explicit separate requests share a result page rather than allowing the
    // longer clause to crowd the other one out. Do not split ordinary prose "and".
    const clauses = query.split(/[;\n]+/).filter((part) => words(part).length > 0);
    if (clauses.length <= 1)
      return this.rankClause(query)
        .slice(0, limit)
        .map((hit) => hit.tool);
    const rankings = clauses.map((clause) =>
      this.rankClause(clause)
        .slice(0, limit)
        .map((hit) => hit.tool),
    );
    const result: Tool[] = [];
    for (let rank = 0; rank < limit && result.length < limit; rank++) {
      for (const ranking of rankings) {
        const tool = ranking[rank];
        if (tool && !result.includes(tool)) result.push(tool);
        if (result.length === limit) break;
      }
    }
    return result;
  }

  /**
   * A deterministic fast path, not a probability or execution decision. Require
   * resource evidence in the name/capability sentence and separation from the
   * runner-up. Every explicit clause must be clear to skip an optional decision
   * model. This does not gate the no-model best-match-first path. The agent can reject a
   * loaded match and choose an unloaded suggestion.
   */
  strongMatches(query: string): Tool[] {
    const clauses = query.split(/[;\n]+/).filter((part) => words(part).length > 0);
    const selected: Tool[] = [];
    for (const clause of clauses) {
      const hits = this.rankClause(clause);
      const best = hits[0];
      if (!best || best.resourceCoverage < 0.5 || (hits[1] && best.score < hits[1].score * 1.25))
        return [];
      if (!selected.includes(best.tool)) selected.push(best.tool);
    }
    return selected;
  }

  /** Best-match-first disclosure without pretending rank is calibrated certainty. */
  bestMatches(query: string): Tool[] {
    const selected: Tool[] = [];
    for (const clause of query.split(/[;\n]+/).filter((part) => words(part).length > 0)) {
      const hits = this.rankClause(clause);
      const best = hits[0];
      // Operation-only/no-resource queries and exact ties remain compact.
      if (!best || best.resourceCoverage === 0 || hits[1]?.score === best.score) return [];
      if (!selected.includes(best.tool)) selected.push(best.tool);
    }
    return selected;
  }

  private rankClause(
    query: string,
  ): Array<{ tool: Tool; score: number; resourceCoverage: number }> {
    const tokens = [...new Set(words(query))];
    if (!tokens.length) return [];
    const queryWeights = new Map(tokens.map((token) => [token, 1]));
    const operation = tokens
      .map((token) => OPERATIONS.find((group) => group.has(token)))
      .find(Boolean);
    const resourceTokens = tokens.filter(isResourceTerm);
    for (const synonym of operation ?? [])
      if (!queryWeights.has(synonym)) queryWeights.set(synonym, 0.25);
    const weights = [4, 2, 0.5, 0.5];
    const normalization = [0.2, 0.25, 0.5, 0.5];
    return this.documents
      .map((doc) => {
        let score = 0;
        for (const [token, queryWeight] of queryWeights) {
          const df = this.documentFrequency.get(token);
          if (!df) continue;
          const idf = Math.log(1 + (this.documents.length - df + 0.5) / (df + 0.5));
          for (let i = 0; i < doc.fields.length; i++) {
            const f = doc.fields[i]!;
            const frequency = f.frequencies.get(token) ?? 0;
            if (!frequency) continue;
            const length =
              1 - normalization[i]! + (normalization[i]! * f.length) / this.averageLengths[i]!;
            score +=
              (queryWeight * idf * weights[i]! * frequency * 2.5) / (frequency + 1.5 * length);
          }
        }
        const namedTerms = tokens.filter((token) => doc.fields[0]!.frequencies.has(token)).length;
        score *= 1 + namedTerms / tokens.length;
        if (operation && doc.operation === operation) score *= 1.5;
        const queryCoverage = resourceTokens.length
          ? resourceTokens.filter(
              (token) =>
                doc.fields[0]!.frequencies.has(token) || doc.fields[1]!.frequencies.has(token),
            ).length / resourceTokens.length
          : 0;
        // Verbose queries should not lose their clear identity match merely
        // because they also explain context. Measure both directions.
        const nameCoverage = doc.resources.length
          ? doc.resources.filter((token) => resourceTokens.includes(token)).length /
            doc.resources.length
          : 0;
        const resourceCoverage = Math.max(queryCoverage, nameCoverage);
        return { tool: doc.tool, score, resourceCoverage };
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score);
  }
}
