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

type Field = { frequencies: Map<string, number>; length: number };
type Document = {
  tool: Tool;
  fields: Field[];
  terms: Set<string>;
  operation: Set<string> | undefined;
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
    if (clauses.length <= 1) return this.rankClause(query, limit);
    const rankings = clauses.map((clause) => this.rankClause(clause, limit));
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

  private rankClause(query: string, limit: number): Tool[] {
    const tokens = [...new Set(words(query))];
    if (!tokens.length) return [];
    const queryWeights = new Map(tokens.map((token) => [token, 1]));
    const operation = tokens
      .map((token) => OPERATIONS.find((group) => group.has(token)))
      .find(Boolean);
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
        return { tool: doc.tool, score };
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((hit) => hit.tool);
  }
}
