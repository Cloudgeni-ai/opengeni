import type { Catalog, Scenario } from "./types";

/**
 * A JSON array or JSON Lines of:
 * `{ id, task?, query?, queries?, acceptable | expected, tags?, notes? }`.
 * Acceptable tools may be written in any form the catalog resolves (model name,
 * `server.tool`, the published name or its underscore form).
 * A scenario where no tool fits has an empty `acceptable` list and the tag `no-fit`;
 * it is right when search loads nothing.
 */
type RawScenario = {
  id?: string;
  task?: string;
  query?: string;
  queries?: string[];
  acceptable?: string[];
  expected?: string[];
  tags?: string[];
  source?: string;
  notes?: string;
};

export async function loadScenarios(path: string, catalog: Catalog) {
  const text = (await Bun.file(path).text()).trim();
  const raw: RawScenario[] = text.startsWith("[")
    ? JSON.parse(text)
    : text
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
  const scenarios: Scenario[] = [];
  const problems: string[] = [];
  raw.forEach((entry, index) => {
    const id = entry.id ?? `scenario-${index + 1}`;
    const queries = entry.queries ?? (entry.query ? [entry.query] : entry.task ? [entry.task] : []);
    if (!queries.length) problems.push(`${id}: no query or task`);
    const references = entry.acceptable ?? entry.expected ?? [];
    const noFit = entry.tags?.includes("no-fit") ?? false;
    if (!references.length && !noFit)
      problems.push(`${id}: no acceptable tools (tag it no-fit if none fits)`);
    const acceptable = new Set<string>();
    for (const reference of references) {
      const names = catalog.resolve(reference);
      if (!names.length) problems.push(`${id}: "${reference}" names no catalog tool`);
      for (const name of names) acceptable.add(name);
    }
    scenarios.push({
      id,
      ...(entry.task ? { task: entry.task } : {}),
      queries,
      acceptable: [...acceptable],
      tags: entry.tags ?? [],
      ...(entry.source ? { source: entry.source } : {}),
      ...(entry.notes ? { notes: entry.notes } : {}),
    });
  });
  return { scenarios, problems };
}
