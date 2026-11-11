import { readFile } from "node:fs/promises";

/**
 * The named sections of knowledge-historical-readers.sql, joined in the order
 * asked: the exact historical Knowledge reader SQL the comparison fixtures
 * install as oracles for the current readers.
 */
export async function historicalKnowledgeSql(...names: string[]): Promise<string> {
  const text = await readFile(new URL("./knowledge-historical-readers.sql", import.meta.url), "utf8");
  const sections = new Map<string, string>();
  const parts = text.split(/^-- section: (\S+)[^\n]*\n/mu);
  for (let index = 1; index < parts.length; index += 2) {
    sections.set(parts[index]!, parts[index + 1]!.replace(/\n+$/u, ""));
  }
  return names
    .map((name) => {
      const section = sections.get(name);
      if (section === undefined) throw new Error(`historical Knowledge SQL ${name} is missing`);
      return section;
    })
    .join("\n\n");
}
