/**
 * POSIX (sh, bash, dash, zsh, ksh) splice. A lexical scanner tracks the quoting
 * context at each reference and emits the variable expansion that yields the
 * value as exactly one word with no further interpretation:
 *
 * | context                     | emission                         |
 * |-----------------------------|----------------------------------|
 * | unquoted word               | `"${V}"`                         |
 * | double quotes, `$(` in `"`  | `${V}`                           |
 * | single quotes               | `'"${V}"'` (close, splice, reopen) |
 * | ANSI-C `$'…'`               | `'"${V}"$'`                      |
 * | unquoted heredoc body       | `${V}`                           |
 * | quoted heredoc body         | literal sentinel (value inline)  |
 * | `$( )`, backticks           | recurse with the same rules      |
 * | comment                     | reference text kept as written   |
 *
 * Nested shells (`bash -c '…'`, `ssh host '…'`, `eval`) re-parse the text the
 * outer shell produced, so a value spliced into their argument is lexed again.
 * The robust idioms pass the value by name instead (`V={{secret:X}} bash -c
 * '… "$V" …'`, `printf %s {{secret:X}} | ssh host 'read -r V; …'`); the
 * variables are exported, so inner shells inherit them.
 */
import type { SecretReference } from "@opengeni/contracts";
import { BindingTable, isReference, type StreamItem } from "./stream";

const WORD_BREAK = new Set([" ", "\t", "\n", ";", "&", "|", "(", ")", "<", ">"]);

interface PendingHeredoc {
  delimiter: string;
  quoted: boolean;
  stripTabs: boolean;
}

type Closer = ")" | "`" | null;

export class PosixSplicer {
  private index = 0;
  private out = "";
  private readonly pending: PendingHeredoc[] = [];

  constructor(
    private readonly items: readonly StreamItem[],
    private readonly table: BindingTable,
  ) {}

  run(): string {
    this.command(null, false);
    // Unbalanced closers at top level are copied verbatim; the shell reports them.
    while (this.index < this.items.length) {
      this.copyCurrent();
      this.command(null, false);
    }
    return this.out;
  }

  private peek(offset = 0): StreamItem | undefined {
    return this.items[this.index + offset];
  }

  private copyCurrent(): void {
    const item = this.items[this.index];
    this.index += 1;
    if (item === undefined) return;
    this.out += isReference(item) ? item.raw : item;
  }

  private env(reference: SecretReference): string {
    return this.table.env(reference);
  }

  /** A command list: top level, `$( … )` or a backtick substitution. */
  private command(closer: Closer, insideDoubleQuotedBackticks: boolean): void {
    let depth = 0;
    let wordStart = true;
    while (this.index < this.items.length) {
      const item = this.peek()!;
      if (isReference(item)) {
        const name = this.env(item);
        this.out += insideDoubleQuotedBackticks ? `\\"\${${name}}\\"` : `"\${${name}}"`;
        this.index += 1;
        wordStart = false;
        continue;
      }
      if (closer === ")" && item === ")" && depth === 0) return;
      if (closer === "`" && item === "`") return;
      switch (item) {
        case "\\": {
          this.copyCurrent();
          if (this.peek() === "\n") {
            this.copyCurrent();
          } else if (this.index < this.items.length) {
            const next = this.peek()!;
            if (isReference(next)) {
              // `\` before a reference: the backslash escapes nothing useful.
              const name = this.env(next);
              this.out += `"\${${name}}"`;
              this.index += 1;
            } else {
              this.copyCurrent();
            }
          }
          wordStart = false;
          continue;
        }
        case "'": {
          this.copyCurrent();
          this.singleQuoted();
          wordStart = false;
          continue;
        }
        case '"': {
          this.copyCurrent();
          this.doubleQuoted();
          wordStart = false;
          continue;
        }
        case "$": {
          const next = this.peek(1);
          if (next === "'") {
            this.copyCurrent();
            this.copyCurrent();
            this.ansiQuoted();
          } else if (next === "(") {
            this.copyCurrent();
            this.copyCurrent();
            this.substitution();
          } else {
            this.copyCurrent();
          }
          wordStart = false;
          continue;
        }
        case "`": {
          this.copyCurrent();
          this.command("`", false);
          if (this.peek() === "`") this.copyCurrent();
          wordStart = false;
          continue;
        }
        case "(":
          depth += 1;
          this.copyCurrent();
          wordStart = true;
          continue;
        case ")":
          depth -= 1;
          this.copyCurrent();
          wordStart = true;
          continue;
        case "#":
          if (wordStart) {
            this.comment();
            continue;
          }
          this.copyCurrent();
          continue;
        case "<":
          if (this.peek(1) === "<" && this.peek(2) !== "<") {
            this.heredocOperator();
            wordStart = true;
            continue;
          }
          if (this.peek(1) === "<" && this.peek(2) === "<") {
            // Here-string: copy the operator; its word is lexed normally.
            this.copyCurrent();
            this.copyCurrent();
            this.copyCurrent();
            wordStart = true;
            continue;
          }
          this.copyCurrent();
          wordStart = true;
          continue;
        case "\n":
          this.copyCurrent();
          this.heredocBodies();
          wordStart = true;
          continue;
        default:
          this.copyCurrent();
          wordStart = WORD_BREAK.has(item);
      }
    }
  }

  /** After `$(` has been copied: the command list, then its `)`. */
  private substitution(): void {
    this.command(")", false);
    if (this.peek() === ")") this.copyCurrent();
  }

  private comment(): void {
    while (this.index < this.items.length && this.peek() !== "\n") this.copyCurrent();
  }

  private singleQuoted(): void {
    while (this.index < this.items.length) {
      const item = this.peek()!;
      if (isReference(item)) {
        this.out += `'"\${${this.env(item)}}"'`;
        this.index += 1;
        continue;
      }
      this.copyCurrent();
      if (item === "'") return;
    }
  }

  private ansiQuoted(): void {
    while (this.index < this.items.length) {
      const item = this.peek()!;
      if (isReference(item)) {
        this.out += `'"\${${this.env(item)}}"$'`;
        this.index += 1;
        continue;
      }
      this.copyCurrent();
      if (item === "\\") {
        if (this.index < this.items.length && !isReference(this.peek())) this.copyCurrent();
        continue;
      }
      if (item === "'") return;
    }
  }

  private doubleQuoted(): void {
    while (this.index < this.items.length) {
      const item = this.peek()!;
      if (isReference(item)) {
        this.out += `\${${this.env(item)}}`;
        this.index += 1;
        continue;
      }
      if (item === "\\") {
        this.copyCurrent();
        if (this.index < this.items.length && !isReference(this.peek())) this.copyCurrent();
        continue;
      }
      if (item === "$" && this.peek(1) === "(") {
        this.copyCurrent();
        this.copyCurrent();
        this.substitution();
        continue;
      }
      if (item === "`") {
        this.copyCurrent();
        this.command("`", true);
        if (this.peek() === "`") this.copyCurrent();
        continue;
      }
      this.copyCurrent();
      if (item === '"') return;
    }
  }

  /** `<<` / `<<-`, optional blanks, then the delimiter word. Copied verbatim. */
  private heredocOperator(): void {
    this.copyCurrent();
    this.copyCurrent();
    let stripTabs = false;
    if (this.peek() === "-") {
      stripTabs = true;
      this.copyCurrent();
    }
    while (this.peek() === " " || this.peek() === "\t") this.copyCurrent();
    let delimiter = "";
    let quoted = false;
    while (this.index < this.items.length) {
      const item = this.peek()!;
      if (isReference(item)) break;
      if (item === "'" || item === '"') {
        quoted = true;
        const quote = item;
        this.copyCurrent();
        while (this.index < this.items.length && this.peek() !== quote) {
          const inner = this.peek()!;
          if (isReference(inner)) break;
          delimiter += inner;
          this.copyCurrent();
        }
        if (this.peek() === quote) this.copyCurrent();
        continue;
      }
      if (item === "\\") {
        quoted = true;
        this.copyCurrent();
        const next = this.peek();
        if (typeof next === "string") {
          delimiter += next;
          this.copyCurrent();
        }
        continue;
      }
      if (WORD_BREAK.has(item)) break;
      delimiter += item;
      this.copyCurrent();
    }
    if (delimiter.length > 0) this.pending.push({ delimiter, quoted, stripTabs });
  }

  /** Called right after a newline: consume every queued heredoc body in order. */
  private heredocBodies(): void {
    while (this.pending.length > 0) {
      const heredoc = this.pending.shift()!;
      this.heredocBody(heredoc);
    }
  }

  private lineMatchesDelimiter(heredoc: PendingHeredoc): number | null {
    let cursor = this.index;
    let line = "";
    while (cursor < this.items.length) {
      const item = this.items[cursor]!;
      if (isReference(item)) return null;
      if (item === "\n") break;
      line += item;
      cursor += 1;
    }
    const candidate = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
    return candidate === heredoc.delimiter ? cursor : null;
  }

  private heredocBody(heredoc: PendingHeredoc): void {
    while (this.index < this.items.length) {
      const end = this.lineMatchesDelimiter(heredoc);
      if (end !== null) {
        while (this.index < end) this.copyCurrent();
        if (this.peek() === "\n") this.copyCurrent();
        return;
      }
      this.heredocLine(heredoc.quoted);
    }
  }

  /** One body line (through its newline). */
  private heredocLine(quoted: boolean): void {
    while (this.index < this.items.length) {
      const item = this.peek()!;
      if (isReference(item)) {
        this.out += quoted ? this.table.sentinel(item) : `\${${this.env(item)}}`;
        this.index += 1;
        continue;
      }
      if (!quoted) {
        if (item === "\\") {
          this.copyCurrent();
          if (this.index < this.items.length && !isReference(this.peek())) this.copyCurrent();
          continue;
        }
        if (item === "$" && this.peek(1) === "(") {
          this.copyCurrent();
          this.copyCurrent();
          this.substitution();
          continue;
        }
        if (item === "`") {
          this.copyCurrent();
          this.command("`", false);
          if (this.peek() === "`") this.copyCurrent();
          continue;
        }
      }
      this.copyCurrent();
      if (item === "\n") return;
    }
  }
}
