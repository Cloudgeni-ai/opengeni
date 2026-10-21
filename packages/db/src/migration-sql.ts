/** Shared lexical helpers for migration classification and source guards. */

/** Split a migration file into top-level statements, honouring dollar quoting. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    if (char === "-" && sql[index + 1] === "-") {
      const newline = sql.indexOf("\n", index);
      const stop = newline === -1 ? sql.length : newline + 1;
      current += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      const close = sql.indexOf("*/", index + 2);
      const stop = close === -1 ? sql.length : close + 2;
      current += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === "'" || char === '"') {
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (sql[cursor] === char && sql[cursor + 1] === char) {
          cursor += 2;
          continue;
        }
        if (sql[cursor] === char) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      current += sql.slice(index, cursor);
      index = cursor;
      continue;
    }
    if (char === "$") {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index))?.[0];
      if (tag) {
        const close = sql.indexOf(tag, index + tag.length);
        const stop = close === -1 ? sql.length : close + tag.length;
        current += sql.slice(index, stop);
        index = stop;
        continue;
      }
    }
    if (char === ";") {
      current += ";";
      if (current.trim()) out.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/**
 * Remove SQL comments, keeping quoted identifiers and single-quoted literals
 * (including E'' escapes) intact so `--` cannot swallow their closing quote.
 * Dollar-quoted bodies are still lexed as code: DO blocks are dollar-quoted.
 * An apostrophe inside a nested dollar-quoted string can therefore keep later
 * comment text visible; the RLS guard's suppressors also strip all comment text.
 */
export function stripComments(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];
    if (char === "-" && next === "-") {
      const end = text.indexOf("\n", index);
      out += " ";
      index = end === -1 ? text.length : end;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      out += " ";
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      const escapes =
        char === "'" && /[eE]/.test(text[index - 1] ?? "") && !/\w/.test(text[index - 2] ?? "");
      let end = index + 1;
      for (; end < text.length; end += 1) {
        if (escapes && text[end] === "\\") {
          end += 1;
          continue;
        }
        if (text[end] === char) {
          if (text[end + 1] === char) {
            end += 1;
            continue;
          }
          break;
        }
      }
      out += text.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}
