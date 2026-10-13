/**
 * PowerShell (Windows PowerShell 5.1 and pwsh 7) splice. References become
 * `${env:V}` expansions; PowerShell never re-parses an expanded value, so the
 * value is inert in every expandable context.
 *
 * | context                          | emission                                   |
 * |----------------------------------|--------------------------------------------|
 * | unquoted (argument or expression) | `${env:V}`                                |
 * | `"…"` (and curly “ ” „)           | `${env:V}`                                |
 * | `'…'` (and curly ‘ ’ ‚ ‛)         | whole string rewritten as `"…"` with `` ` ``, `$` and double quotes escaped |
 * | `@"…"@` here-string               | `${env:V}`                                 |
 * | `@'…'@` here-string               | rewritten as `@"…"@` with `` ` `` and `$` escaped, then `${env:V}` |
 * | `$( … )`                          | recurse                                    |
 * | `#` and `<# … #>` comments        | reference text kept as written             |
 */
import { SecretReferenceError, type SecretReference } from "@opengeni/contracts";
import { BindingTable, isReference, type StreamItem } from "./stream";

const SINGLE_QUOTES = new Set(["'", "\u2018", "\u2019", "\u201a", "\u201b"]);
const DOUBLE_QUOTES = new Set(['"', "\u201c", "\u201d", "\u201e"]);
const TOKEN_BREAK = new Set([" ", "\t", "\r", "\n", ";", "|", "&", "(", ")", "{", "}", ","]);

export class PowerShellSplicer {
  private index = 0;
  private out = "";

  constructor(
    private readonly items: readonly StreamItem[],
    private readonly table: BindingTable,
  ) {}

  run(): string {
    this.code(false);
    while (this.index < this.items.length) {
      this.copyCurrent();
      this.code(false);
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

  private expansion(reference: SecretReference): string {
    return `\${env:${this.table.env(reference)}}`;
  }

  /**
   * `--%` passes the rest of the line to the native command verbatim, so an
   * expansion there would arrive as literal text. Refuse references in it.
   */
  private stopParsing(): void {
    while (this.index < this.items.length) {
      const item = this.peek()!;
      if (isReference(item)) {
        throw new SecretReferenceError([
          {
            raw: item.raw,
            code: "unsupported_shell",
            message:
              "secret references cannot follow --% (PowerShell passes that text verbatim); pass the value as a normal argument or with {{secretfile:…}}",
          },
        ]);
      }
      if (item === "\n" || item === "|") return;
      this.copyCurrent();
    }
  }

  /** Script code; `nested` stops at the `)` closing a `$(`. */
  private code(nested: boolean): void {
    let depth = 0;
    let tokenStart = true;
    while (this.index < this.items.length) {
      const item = this.peek()!;
      if (isReference(item)) {
        this.out += this.expansion(item);
        this.index += 1;
        tokenStart = false;
        continue;
      }
      if (nested && item === ")" && depth === 0) return;
      if (item === "`") {
        this.copyCurrent();
        if (this.index < this.items.length && !isReference(this.peek())) this.copyCurrent();
        tokenStart = false;
        continue;
      }
      if (tokenStart && item === "-" && this.peek(1) === "-" && this.peek(2) === "%") {
        this.stopParsing();
        tokenStart = true;
        continue;
      }
      if (item === "<" && this.peek(1) === "#") {
        this.blockComment();
        tokenStart = true;
        continue;
      }
      if (item === "#" && tokenStart) {
        while (this.index < this.items.length && this.peek() !== "\n") this.copyCurrent();
        continue;
      }
      if (item === "@" && (this.peek(1) === '"' || this.peek(1) === "'")) {
        if (this.hereStringStartsHere()) {
          this.hereString(this.peek(1) === '"');
          tokenStart = false;
          continue;
        }
      }
      if (SINGLE_QUOTES.has(item)) {
        this.singleQuoted();
        tokenStart = false;
        continue;
      }
      if (DOUBLE_QUOTES.has(item)) {
        this.copyCurrent();
        this.doubleQuoted();
        tokenStart = false;
        continue;
      }
      if (item === "$" && this.peek(1) === "(") {
        this.copyCurrent();
        this.copyCurrent();
        this.code(true);
        if (this.peek() === ")") this.copyCurrent();
        tokenStart = false;
        continue;
      }
      if (item === "(") depth += 1;
      if (item === ")") depth -= 1;
      this.copyCurrent();
      tokenStart = TOKEN_BREAK.has(item);
    }
  }

  private blockComment(): void {
    while (this.index < this.items.length) {
      if (this.peek() === "#" && this.peek(1) === ">") {
        this.copyCurrent();
        this.copyCurrent();
        return;
      }
      this.copyCurrent();
    }
  }

  /** `@"` / `@'` opens a here-string only when followed by a newline. */
  private hereStringStartsHere(): boolean {
    let cursor = this.index + 2;
    while (this.items[cursor] === " " || this.items[cursor] === "\t") cursor += 1;
    if (this.items[cursor] === "\r") cursor += 1;
    return this.items[cursor] === "\n";
  }

  /** True when a reference occurs before the here-string's terminator line. */
  private hereStringHasReference(quote: string): boolean {
    let lineStart = false;
    for (let cursor = this.index + 2; cursor < this.items.length; cursor += 1) {
      const item = this.items[cursor];
      if (isReference(item)) return true;
      if (lineStart && item === quote && this.items[cursor + 1] === "@") return false;
      lineStart = item === "\n";
    }
    return false;
  }

  private hereString(expandable: boolean): void {
    const quote = expandable ? '"' : "'";
    if (!expandable && this.hereStringHasReference(quote)) {
      this.literalHereStringAsExpandable();
      return;
    }
    this.copyCurrent();
    this.copyCurrent();
    let lineStart = false;
    while (this.index < this.items.length) {
      const item = this.peek()!;
      if (isReference(item)) {
        this.out += this.expansion(item);
        this.index += 1;
        lineStart = false;
        continue;
      }
      if (lineStart && item === quote && this.peek(1) === "@") {
        this.copyCurrent();
        this.copyCurrent();
        return;
      }
      if (expandable && item === "`") {
        this.copyCurrent();
        if (this.index < this.items.length && !isReference(this.peek())) this.copyCurrent();
        lineStart = false;
        continue;
      }
      if (expandable && item === "$" && this.peek(1) === "(") {
        this.copyCurrent();
        this.copyCurrent();
        this.code(true);
        if (this.peek() === ")") this.copyCurrent();
        lineStart = false;
        continue;
      }
      this.copyCurrent();
      lineStart = item === "\n";
    }
  }

  /**
   * `@'…'@` keeps its body literal. When it holds a reference, emit it as
   * `@"…"@` with every backtick and `$` escaped (and a line-initial `"`, which
   * could otherwise close the string), so the text is unchanged and the
   * reference becomes an expansion that is never re-parsed.
   */
  private literalHereStringAsExpandable(): void {
    this.index += 2;
    this.out += '@"';
    let lineStart = false;
    while (this.index < this.items.length) {
      const item = this.peek()!;
      this.index += 1;
      if (isReference(item)) {
        this.out += this.expansion(item);
        lineStart = false;
        continue;
      }
      if (lineStart && item === "'" && this.peek() === "@") {
        this.index += 1;
        this.out += '"@';
        return;
      }
      if (item === "`" || item === "$") this.out += `\`${item}`;
      else if (lineStart && item === '"') this.out += '`"';
      else this.out += item;
      lineStart = item === "\n";
    }
  }

  private doubleQuoted(): void {
    while (this.index < this.items.length) {
      const item = this.peek()!;
      if (isReference(item)) {
        this.out += this.expansion(item);
        this.index += 1;
        continue;
      }
      if (item === "`") {
        this.copyCurrent();
        if (this.index < this.items.length && !isReference(this.peek())) this.copyCurrent();
        continue;
      }
      if (item === "$" && this.peek(1) === "(") {
        this.copyCurrent();
        this.copyCurrent();
        this.code(true);
        if (this.peek() === ")") this.copyCurrent();
        continue;
      }
      if (DOUBLE_QUOTES.has(item)) {
        // A doubled quote is an escaped quote inside the string.
        const next = this.peek(1);
        if (typeof next === "string" && DOUBLE_QUOTES.has(next)) {
          this.copyCurrent();
          this.copyCurrent();
          continue;
        }
        this.copyCurrent();
        return;
      }
      this.copyCurrent();
    }
  }

  /**
   * A verbatim string cannot expand anything, so a string holding a reference
   * is re-emitted as an equivalent expandable string. Strings without
   * references are copied byte for byte.
   */
  private singleQuoted(): void {
    const start = this.index;
    let cursor = this.index + 1;
    let hasReference = false;
    let closed = false;
    while (cursor < this.items.length) {
      const item = this.items[cursor]!;
      if (isReference(item)) {
        hasReference = true;
        cursor += 1;
        continue;
      }
      if (SINGLE_QUOTES.has(item)) {
        const next = this.items[cursor + 1];
        if (typeof next === "string" && SINGLE_QUOTES.has(next)) {
          cursor += 2;
          continue;
        }
        closed = true;
        cursor += 1;
        break;
      }
      cursor += 1;
    }
    if (!hasReference || !closed) {
      while (this.index < cursor) {
        const item = this.peek()!;
        if (isReference(item)) {
          this.out += this.expansion(item);
          this.index += 1;
        } else {
          this.copyCurrent();
        }
      }
      return;
    }
    let rewritten = '"';
    let position = start + 1;
    const end = cursor - 1;
    while (position < end) {
      const item = this.items[position]!;
      if (isReference(item)) {
        rewritten += this.expansion(item);
        position += 1;
        continue;
      }
      if (SINGLE_QUOTES.has(item)) {
        // Only doubled quotes can appear here: they stand for one quote.
        rewritten += item;
        position += 2;
        continue;
      }
      if (item === "`" || item === "$" || DOUBLE_QUOTES.has(item)) {
        rewritten += `\`${item}`;
        position += 1;
        continue;
      }
      rewritten += item;
      position += 1;
    }
    rewritten += '"';
    this.out += rewritten;
    this.index = cursor;
  }
}
