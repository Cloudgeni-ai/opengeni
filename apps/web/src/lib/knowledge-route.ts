/* ----------------------------------------------------------------------------
   The Knowledge page's URL (/state): which tab, or which page you opened from
   it. A leaf module so the route table can parse it without loading the page.
   -------------------------------------------------------------------------- */

export type KnowledgeTab = "library" | "instructions" | "review";

/** Pages opened from the Knowledge page, each with a back link. */
export type KnowledgeSubpage =
  | "add"
  | "edit"
  | "learning"
  | "instructions"
  | "identity"
  | "edit-instructions"
  | "instructions-history";

export interface KnowledgeSearch {
  /** Library is the default tab. `files` and `skills` are old links. */
  view?: "instructions" | "review" | "files" | "skills";
  /** An entry or collection page. */
  entry?: string;
  /** An earlier revision of that entry. */
  revision?: string;
  page?: KnowledgeSubpage;
  /** Add knowledge into this collection. */
  collection?: string;
  /** Knowledge that came from this file. */
  file?: string;
  /** One change waiting in Review ("knowledge:<id>", "instruction:<id>", "skill:<id>"). */
  proposal?: string;
  /** Old rail links: the Review tab. */
  review?: boolean;
  /** Opens the Library filtered to one scope (old Documents links, Organization documents). */
  scope?: KnowledgeScopeFilter;
}

export type KnowledgeScopeFilter = "organization" | "workspace" | "personal";

function scopeFilter(value: unknown): KnowledgeScopeFilter | undefined {
  return value === "organization" || value === "workspace" || value === "personal"
    ? value
    : undefined;
}

const SUBPAGES: readonly KnowledgeSubpage[] = [
  "add",
  "edit",
  "learning",
  "instructions",
  "identity",
  "edit-instructions",
  "instructions-history",
];

const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const PROPOSAL = /^(?:knowledge|instruction|skill):[A-Za-z0-9_-]{1,128}$/u;

function id(value: unknown): string | undefined {
  return typeof value === "string" && ID.test(value) ? value : undefined;
}

/**
 * Where an old Documents link (/documents) opens on the Knowledge page: a
 * `?memory=` bookmark opens its entry, `?authority=` opens the Library filtered
 * to that scope, and anything else the Library's files.
 */
export function documentsRedirectSearch(search: {
  memory?: string | undefined;
  authority?: string | undefined;
}): KnowledgeSearch {
  if (search.memory) return parseKnowledgeSearch({ entry: search.memory });
  const scope = scopeFilter(search.authority);
  return scope ? { scope } : { view: "files" };
}

/** Parses the /state search. Unknown values are dropped. */
export function parseKnowledgeSearch(search: Record<string, unknown>): KnowledgeSearch {
  const view =
    search.view === "instructions" ||
    search.view === "review" ||
    search.view === "files" ||
    search.view === "skills"
      ? search.view
      : undefined;
  const page = SUBPAGES.find((each) => each === search.page);
  const entry = id(search.entry);
  const revision = entry ? id(search.revision) : undefined;
  const collection = id(search.collection);
  const file = typeof search.file === "string" && search.file ? search.file : undefined;
  const proposal =
    typeof search.proposal === "string" && PROPOSAL.test(search.proposal)
      ? search.proposal
      : undefined;
  const scope = scopeFilter(search.scope);
  return {
    ...(view ? { view } : {}),
    ...(entry ? { entry } : {}),
    ...(revision ? { revision } : {}),
    ...(page ? { page } : {}),
    ...(collection ? { collection } : {}),
    ...(file ? { file } : {}),
    ...(proposal ? { proposal } : {}),
    ...(search.review === true ? { review: true } : {}),
    ...(scope ? { scope } : {}),
  };
}
