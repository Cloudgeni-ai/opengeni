export type HelpEntry = Record<string, unknown> & {
  path: string;
  summary: string;
  examples: string[];
};

export function defineHelpEntries(
  entries: readonly (readonly [path: string, summary: string, ...examples: string[]])[],
): HelpEntry[] {
  return entries.map(([path, summary, ...examples]) => ({ path, summary, examples }));
}

export function filterHelpEntries(
  entries: readonly HelpEntry[],
  query: string,
  search?: string,
  stripQueryPrefix = "",
): HelpEntry[] {
  const normalized = query.trim().toLowerCase().replace(stripQueryPrefix, "");
  return entries.filter((entry) => {
    const content = `${entry.path} ${entry.summary} ${entry.examples.join(" ")}`.toLowerCase();
    const matches = normalized === "*" || content.includes(normalized);
    if (!matches || !search) return matches;
    try {
      return new RegExp(search, "iu").test(content);
    } catch {
      return content.includes(search.toLowerCase());
    }
  });
}

export function boundInspectionRecords(
  records: readonly Record<string, unknown>[],
  maxChars: number,
) {
  const accepted: Record<string, unknown>[] = [];
  const lines: string[] = [];
  let chars = 0;
  for (const record of records) {
    const line = JSON.stringify(record);
    const additional = line.length + (accepted.length > 0 ? 1 : 0);
    if (chars + additional > maxChars) {
      return { records: accepted, ndjson: lines.join("\n"), truncated: true };
    }
    accepted.push(record);
    lines.push(line);
    chars += additional;
  }
  return { records: accepted, ndjson: lines.join("\n"), truncated: false };
}
