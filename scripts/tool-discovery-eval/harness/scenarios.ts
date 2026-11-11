import type { Catalog, Scenario } from "./types";

/**
 * A JSON array or JSON Lines of:
 * `{ id, task?, query?, queries?, acceptable | expected, needs?, limit?, tags?, notes? }`.
 * Acceptable tools may be written in any form the catalog resolves (model name,
 * `server.tool`, the published name or its underscore form).
 * `needs` splits a search that asks for several things into what each need
 * accepts (a list of lists); its tools are acceptable too. So are the tools an
 * acceptable tool's description names (the tool to call first or to get an
 * input from): loading them is not wrong, though no need requires them.
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
  needs?: string[][];
  limit?: number;
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
  const descriptions = new Map(
    catalog.functionTools.map((tool) => [
      (tool as { name: string }).name,
      (tool as { description?: string }).description ?? "",
    ]),
  );
  const servers = new Map(catalog.tools.map((tool) => [tool.name, tool.server]));
  const namedBy = (name: string) =>
    (descriptions.get(name) ?? "")
      .split(/[^A-Za-z0-9_.-]+/)
      .map((token) => token.replace(/^[_.-]+|[_.-]+$/g, ""))
      .filter((token) => /[_.]/.test(token) && /[a-z]/i.test(token))
      .flatMap((token) => catalog.resolve(token))
      // A description names its own server's tools.
      .filter((named) => named !== name && servers.get(named) === servers.get(name));
  raw.forEach((entry, index) => {
    const id = entry.id ?? `scenario-${index + 1}`;
    const queries = entry.queries ?? (entry.query ? [entry.query] : entry.task ? [entry.task] : []);
    if (!queries.length) problems.push(`${id}: no query or task`);
    const references = [
      ...(entry.acceptable ?? entry.expected ?? []),
      ...(entry.needs ?? []).flat(),
    ];
    const noFit = entry.tags?.includes("no-fit") ?? false;
    if (!references.length && !noFit)
      problems.push(`${id}: no acceptable tools (tag it no-fit if none fits)`);
    const resolve = (reference: string) => {
      const names = catalog.resolve(reference);
      if (!names.length) problems.push(`${id}: "${reference}" names no catalog tool`);
      return names;
    };
    const acceptable = new Set(references.flatMap(resolve));
    // A tool an acceptable tool's own description says to use first ("find
    // sourceItemId with form_templates.list_system_checklist_tree", "upload it
    // first with files.create_upload") is part of the job too: loading it is
    // not wrong, though no need requires it.
    for (const name of [...acceptable]) for (const named of namedBy(name)) acceptable.add(named);
    const needs = entry.needs?.map((need) => [...new Set(need.flatMap(resolve))]);
    if (needs?.some((need) => !need.length)) problems.push(`${id}: a need accepts no tool`);
    if (entry.limit !== undefined && !(Number.isInteger(entry.limit) && entry.limit > 0))
      problems.push(`${id}: limit must be a positive integer`);
    scenarios.push({
      id,
      ...(entry.task ? { task: entry.task } : {}),
      queries,
      acceptable: [...acceptable],
      ...(needs ? { needs } : {}),
      ...(entry.limit !== undefined ? { limit: entry.limit } : {}),
      tags: entry.tags ?? [],
      ...(entry.source ? { source: entry.source } : {}),
      ...(entry.notes ? { notes: entry.notes } : {}),
    });
  });
  return { scenarios, problems };
}
