export type BudgetAnalysis = Readonly<{
  minutes: number;
  uncertainties: readonly string[];
}>;

export type TimeoutStep = Readonly<{
  run?: string;
  shell?: string;
  "timeout-minutes"?: unknown;
}>;

type WordToken = Readonly<{
  kind: "word";
  value: string;
  dynamic: boolean;
  segments: readonly WordSegment[];
  effects: readonly BudgetAnalysis[];
}>;

type WordSegment =
  | Readonly<{ kind: "literal"; value: string }>
  | Readonly<{ kind: "variable"; name: string | null }>
  | Readonly<{ kind: "substitution" }>;

type OperatorToken = Readonly<{
  kind: "operator";
  value: string;
}>;

type ShellToken = WordToken | OperatorToken;

const ZERO: BudgetAnalysis = { minutes: 0, uncertainties: [] };
const LIST_SEPARATORS = new Set(["\n", ";", "&&", "||", "&"]);
const PROSE_COMMANDS = new Set(["echo", "printf"]);
const SHELL_COMMANDS = new Set(["bash", "dash", "sh", "zsh"]);
const TIMEOUT_COMMANDS = new Set(["timeout", "gtimeout"]);
const MAX_ANALYSIS_DEPTH = 32;

function sum(analyses: readonly BudgetAnalysis[]): BudgetAnalysis {
  return {
    minutes: analyses.reduce((total, analysis) => total + analysis.minutes, 0),
    uncertainties: analyses.flatMap((analysis) => analysis.uncertainties),
  };
}

function maximum(analyses: readonly BudgetAnalysis[]): BudgetAnalysis {
  return {
    minutes: Math.max(0, ...analyses.map((analysis) => analysis.minutes)),
    uncertainties: analyses.flatMap((analysis) => analysis.uncertainties),
  };
}

function scaled(analysis: BudgetAnalysis, factor: number): BudgetAnalysis {
  return {
    minutes: analysis.minutes * factor,
    uncertainties: analysis.uncertainties,
  };
}

function uncertain(message: string, minutes = 0): BudgetAnalysis {
  return { minutes, uncertainties: [message] };
}

function appendLiteral(segments: WordSegment[], value: string): void {
  if (value.length === 0) return;
  const previous = segments[segments.length - 1];
  if (previous?.kind === "literal") {
    segments[segments.length - 1] = { kind: "literal", value: previous.value + value };
  } else {
    segments.push({ kind: "literal", value });
  }
}

function resolveSegments(
  segments: readonly WordSegment[],
  variables: ReadonlyMap<string, string | null>,
): string | null {
  let value = "";
  for (const segment of segments) {
    if (segment.kind === "literal") value += segment.value;
    else if (segment.kind === "variable" && segment.name && variables.has(segment.name)) {
      const resolved = variables.get(segment.name);
      if (resolved === null || resolved === undefined) return null;
      value += resolved;
    } else return null;
  }
  return value;
}

function resolveWord(
  word: WordToken | undefined,
  variables: ReadonlyMap<string, string | null>,
): string | null {
  return word ? resolveSegments(word.segments, variables) : null;
}

type ExtractedSubstitution = Readonly<{ content: string; end: number }>;

function readBacktick(source: string, start: number): ExtractedSubstitution | null {
  let content = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index] as string;
    if (char === "\\" && source[index + 1] !== undefined) {
      content += source[index + 1] as string;
      index += 1;
      continue;
    }
    if (char === "`") return { content, end: index };
    content += char;
  }
  return null;
}

function readParenthesized(source: string, open: number): ExtractedSubstitution | null {
  let depth = 1;
  let quote: "single" | "double" | null = null;
  for (let index = open + 1; index < source.length; index += 1) {
    const char = source[index] as string;
    const next = source[index + 1];
    if (quote === "single") {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === "double") {
      if (char === '"') quote = null;
      else if (char === "\\" && next !== undefined) index += 1;
      else if (char === "$" && next === "(" && source[index + 2] !== "(") {
        const nested = readParenthesized(source, index + 1);
        if (!nested) return null;
        index = nested.end;
      } else if (char === "`") {
        const nested = readBacktick(source, index);
        if (!nested) return null;
        index = nested.end;
      }
      continue;
    }
    if (char === "\\") {
      if (next !== undefined) index += 1;
      continue;
    }
    if (char === "'") {
      quote = "single";
      continue;
    }
    if (char === '"') {
      quote = "double";
      continue;
    }
    if (char === "`") {
      const nested = readBacktick(source, index);
      if (!nested) return null;
      index = nested.end;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return { content: source.slice(open + 1, index), end: index };
    }
  }
  return null;
}

function expansionEffects(source: string, depth: number): BudgetAnalysis {
  if (depth > MAX_ANALYSIS_DEPTH) return uncertain("shell expansion nesting is too deep");
  const analyses: BudgetAnalysis[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] as string;
    if (char === "\\") {
      if (source[index + 1] !== undefined) index += 1;
      continue;
    }
    if (char === "$" && source[index + 1] === "(" && source[index + 2] !== "(") {
      const extracted = readParenthesized(source, index + 1);
      if (!extracted) {
        analyses.push(uncertain("malformed command substitution"));
        break;
      }
      analyses.push(analyzeShellTimeoutBudgetInternal(extracted.content, depth + 1));
      index = extracted.end;
      continue;
    }
    if (char === "`") {
      const extracted = readBacktick(source, index);
      if (!extracted) {
        analyses.push(uncertain("malformed backtick command substitution"));
        break;
      }
      analyses.push(analyzeShellTimeoutBudgetInternal(extracted.content, depth + 1));
      index = extracted.end;
    }
  }
  return sum(analyses);
}

/**
 * Remove literal here-document bodies before tokenization. They are data, not
 * shell commands. Malformed declarations remain an explicit uncertainty.
 */
type HereDocument = Readonly<{
  delimiter: string;
  stripTabs: boolean;
  expandBody: boolean;
}>;

function hereDocumentsOnLine(line: string): Readonly<{
  declarations: readonly HereDocument[];
  malformed: boolean;
}> {
  const declarations: HereDocument[] = [];
  let malformed = false;
  let quote: "single" | "double" | null = null;
  let atWordBoundary = true;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string;
    const next = line[index + 1];
    if (quote === "single") {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === "double") {
      if (char === '"') quote = null;
      else if (char === "\\" && next !== undefined) index += 1;
      continue;
    }
    if (char === "\\") {
      index += next === undefined ? 0 : 1;
      atWordBoundary = false;
      continue;
    }
    if (char === "'") {
      quote = "single";
      atWordBoundary = false;
      continue;
    }
    if (char === '"') {
      quote = "double";
      atWordBoundary = false;
      continue;
    }
    if (char === "#" && atWordBoundary) break;
    if (char === "<" && next === "<" && line[index + 2] === "<") {
      index += 2;
      atWordBoundary = false;
      continue;
    }
    if (char !== "<" || next !== "<") {
      atWordBoundary = /[\s;&|()]/u.test(char);
      continue;
    }

    let cursor = index + 2;
    let stripTabs = false;
    if (line[cursor] === "-") {
      stripTabs = true;
      cursor += 1;
    }
    while (line[cursor] === " " || line[cursor] === "\t") cursor += 1;
    let delimiter = "";
    let delimiterQuote: "single" | "double" | null = null;
    let ansiQuoted = false;
    let quoted = false;
    while (cursor < line.length) {
      const delimiterChar = line[cursor] as string;
      if (delimiterQuote === "single") {
        if (delimiterChar === "'") {
          delimiterQuote = null;
          ansiQuoted = false;
        } else if (ansiQuoted && delimiterChar === "\\") {
          // ANSI-C quoting can synthesize arbitrary delimiter bytes. It is
          // quoted (so its body is inert), but resolving escapes belongs to a
          // real shell parser; retain a fail-closed malformed declaration.
          malformed = true;
          delimiter += delimiterChar;
        } else delimiter += delimiterChar;
        cursor += 1;
        continue;
      }
      if (delimiterQuote === "double") {
        if (delimiterChar === '"') delimiterQuote = null;
        else if (delimiterChar === "\\" && line[cursor + 1] !== undefined) {
          delimiter += line[(cursor += 1)] as string;
        } else delimiter += delimiterChar;
        cursor += 1;
        continue;
      }
      if (/[\s;&|()<>]/u.test(delimiterChar)) break;
      if (delimiterChar === "$" && ["'", '"'].includes(line[cursor + 1] ?? "")) {
        quoted = true;
        ansiQuoted = line[cursor + 1] === "'";
        delimiterQuote = ansiQuoted ? "single" : "double";
        cursor += 2;
        continue;
      }
      if (delimiterChar === "'") {
        quoted = true;
        delimiterQuote = "single";
      } else if (delimiterChar === '"') {
        quoted = true;
        delimiterQuote = "double";
      } else if (delimiterChar === "\\" && line[cursor + 1] !== undefined) {
        quoted = true;
        delimiter += line[(cursor += 1)] as string;
      } else delimiter += delimiterChar;
      cursor += 1;
    }
    if (delimiterQuote !== null) malformed = true;
    if (delimiter.length > 0 && delimiterQuote === null) {
      declarations.push({ delimiter, stripTabs, expandBody: !quoted });
    } else malformed = true;
    index = Math.max(index + 1, cursor - 1);
    atWordBoundary = false;
  }
  return { declarations, malformed };
}

function stripStaticHereDocuments(
  source: string,
  depth: number,
): Readonly<{
  input: string;
  uncertainties: readonly string[];
  effects: readonly BudgetAnalysis[];
}> {
  const lines = source.split("\n");
  const out: string[] = [];
  const pending: Array<HereDocument & { body: string[] }> = [];
  const effects: BudgetAnalysis[] = [];
  let malformed = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    out.push(line);
    if (pending.length > 0) continue;

    const found = hereDocumentsOnLine(line);
    pending.push(...found.declarations.map((declaration) => ({ ...declaration, body: [] })));
    malformed ||= found.malformed;

    while (pending.length > 0 && index + 1 < lines.length) {
      const bodyLine = lines[(index += 1)] as string;
      const current = pending[0] as (typeof pending)[number];
      const candidate = current.stripTabs ? bodyLine.replace(/^\t+/u, "") : bodyLine;
      out.push(candidate === current.delimiter ? bodyLine : "");
      if (candidate === current.delimiter) {
        if (current.expandBody) effects.push(expansionEffects(current.body.join("\n"), depth));
        pending.shift();
      } else current.body.push(bodyLine);
    }
  }
  return {
    input: out.join("\n"),
    uncertainties: malformed || pending.length > 0 ? ["malformed here-document delimiter"] : [],
    effects,
  };
}

function lexShell(
  source: string,
  depth: number,
): BudgetAnalysis & Readonly<{ tokens: readonly ShellToken[] }> {
  const stripped = stripStaticHereDocuments(source, depth);
  const input = stripped.input;
  const tokens: ShellToken[] = [];
  const uncertainties: string[] = [...stripped.uncertainties];
  let value = "";
  let dynamic = false;
  let quote: "single" | "double" | null = null;
  let segments: WordSegment[] = [];
  let effects: BudgetAnalysis[] = [];
  let started = false;

  const literal = (text: string) => {
    started = true;
    value += text;
    appendLiteral(segments, text);
  };
  const unknown = (raw: string, name: string | null, analysis?: BudgetAnalysis) => {
    started = true;
    dynamic = true;
    value += raw;
    segments.push({ kind: analysis ? "substitution" : "variable", ...(analysis ? {} : { name }) });
    if (analysis) effects.push(analysis);
  };
  const pushWord = () => {
    if (!started) return;
    tokens.push({ kind: "word", value, dynamic, segments, effects });
    value = "";
    dynamic = false;
    segments = [];
    effects = [];
    started = false;
  };
  const commandSubstitution = (inputIndex: number): number => {
    const extracted = readParenthesized(input, inputIndex + 1);
    if (!extracted) {
      unknown(input.slice(inputIndex), null);
      uncertainties.push("malformed command substitution");
      return input.length - 1;
    }
    unknown(
      input.slice(inputIndex, extracted.end + 1),
      null,
      analyzeShellTimeoutBudgetInternal(extracted.content, depth + 1),
    );
    return extracted.end;
  };
  const backtickSubstitution = (inputIndex: number): number => {
    const extracted = readBacktick(input, inputIndex);
    if (!extracted) {
      unknown(input.slice(inputIndex), null);
      uncertainties.push("malformed backtick command substitution");
      return input.length - 1;
    }
    unknown(
      input.slice(inputIndex, extracted.end + 1),
      null,
      analyzeShellTimeoutBudgetInternal(extracted.content, depth + 1),
    );
    return extracted.end;
  };
  const dollarExpansion = (inputIndex: number): number => {
    const next = input[inputIndex + 1];
    if (next === "(" && input[inputIndex + 2] !== "(") {
      return commandSubstitution(inputIndex);
    }
    if (next === "(") {
      const extracted = readParenthesized(input, inputIndex + 1);
      if (!extracted) {
        unknown(input.slice(inputIndex), null);
        uncertainties.push("malformed arithmetic expansion");
        return input.length - 1;
      }
      const raw = input.slice(inputIndex, extracted.end + 1);
      unknown(raw, null);
      effects.push(expansionEffects(extracted.content, depth + 1));
      return extracted.end;
    }
    if (next === "{" && input[inputIndex + 2] === "{") {
      const end = input.indexOf("}}", inputIndex + 3);
      const final = end < 0 ? input.length - 1 : end + 1;
      unknown(input.slice(inputIndex, final + 1), null);
      if (end < 0) uncertainties.push("malformed Actions expression");
      return final;
    }
    if (next === "{") {
      const end = input.indexOf("}", inputIndex + 2);
      const final = end < 0 ? input.length - 1 : end;
      const body = input.slice(inputIndex + 2, end < 0 ? input.length : end);
      unknown(
        input.slice(inputIndex, final + 1),
        /^[A-Za-z_][A-Za-z0-9_]*$/u.test(body) ? body : null,
      );
      effects.push(expansionEffects(body, depth + 1));
      if (end < 0) uncertainties.push("malformed parameter expansion");
      return final;
    }
    if (next && /[A-Za-z_]/u.test(next)) {
      let end = inputIndex + 2;
      while (end < input.length && /[A-Za-z0-9_]/u.test(input[end] as string)) end += 1;
      const name = input.slice(inputIndex + 1, end);
      unknown(input.slice(inputIndex, end), name);
      return end - 1;
    }
    if (next && /[0-9@*#?$!_-]/u.test(next)) {
      unknown(input.slice(inputIndex, inputIndex + 2), null);
      return inputIndex + 1;
    }
    literal("$");
    return inputIndex;
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string;
    const next = input[index + 1];
    if (quote === "single") {
      if (char === "'") quote = null;
      else if (char === "$" && next === "{" && input[index + 2] === "{") {
        index = dollarExpansion(index);
      } else literal(char);
      continue;
    }
    if (quote === "double") {
      if (char === '"') quote = null;
      else if (char === "\\" && next !== undefined && '"\\$`\n'.includes(next)) {
        if (next === "\n") index += 1;
        else literal(input[(index += 1)] as string);
      } else if (char === "$") index = dollarExpansion(index);
      else if (char === "`") index = backtickSubstitution(index);
      else literal(char);
      continue;
    }
    if (char === "\\") {
      if (next === "\n") index += 1;
      else if (next !== undefined) literal(input[(index += 1)] as string);
      else literal(char);
      continue;
    }
    if (char === "'") {
      quote = "single";
      started = true;
      continue;
    }
    if (char === '"') {
      quote = "double";
      started = true;
      continue;
    }
    if (char === "$" && next === "'") {
      started = true;
      let cursor = index + 2;
      let ansi = "";
      let escaped = false;
      while (cursor < input.length && input[cursor] !== "'") {
        if (input[cursor] === "\\") escaped = true;
        ansi += input[cursor] as string;
        cursor += 1;
      }
      if (cursor >= input.length) uncertainties.push("unterminated ANSI-C shell quote");
      if (escaped) unknown(input.slice(index, Math.min(cursor + 1, input.length)), null);
      else literal(ansi);
      index = Math.min(cursor, input.length - 1);
      continue;
    }
    if (char === "$" && next === '"') {
      quote = "double";
      started = true;
      index += 1;
      continue;
    }
    if (char === "$") {
      index = dollarExpansion(index);
      continue;
    }
    if (char === "`") {
      index = backtickSubstitution(index);
      continue;
    }
    if ((char === "<" || char === ">") && next === "(") {
      const extracted = readParenthesized(input, index + 1);
      if (!extracted) {
        unknown(input.slice(index), null);
        uncertainties.push("malformed process substitution");
        index = input.length - 1;
      } else {
        unknown(
          input.slice(index, extracted.end + 1),
          null,
          analyzeShellTimeoutBudgetInternal(extracted.content, depth + 1),
        );
        index = extracted.end;
      }
      continue;
    }
    if (char === "#" && !started) {
      while (index + 1 < input.length && input[index + 1] !== "\n") index += 1;
      continue;
    }
    if (char === "\n") {
      pushWord();
      tokens.push({ kind: "operator", value: "\n" });
      continue;
    }
    if (/\s/u.test(char)) {
      pushWord();
      continue;
    }
    const pair = `${char}${next ?? ""}`;
    if (["&&", "||", ";;", "|&"].includes(pair)) {
      pushWord();
      tokens.push({ kind: "operator", value: pair });
      index += 1;
      continue;
    }
    if (";|&()".includes(char)) {
      pushWord();
      tokens.push({ kind: "operator", value: char });
      continue;
    }
    literal(char);
  }
  pushWord();

  if (quote !== null) uncertainties.push("unterminated shell quote");
  const hereDocumentEffects = sum(stripped.effects);
  return {
    minutes: hereDocumentEffects.minutes,
    uncertainties: [...uncertainties, ...hereDocumentEffects.uncertainties],
    tokens,
  };
}

function parseDuration(value: string | null | undefined, context: string): BudgetAnalysis {
  if (value === undefined) return uncertain(`${context} has no duration`);
  if (value === null) return uncertain(`${context} uses a dynamic duration`);
  const match = /^(\d+(?:\.\d+)?)([smhd]?)$/u.exec(value);
  if (!match) return uncertain(`${context} has an unsupported duration ${JSON.stringify(value)}`);
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return uncertain(`${context} has a non-positive duration`);
  }
  const multiplier = { "": 1 / 60, s: 1 / 60, m: 1, h: 60, d: 1440 }[
    match[2] as "" | "s" | "m" | "h" | "d"
  ];
  return { minutes: amount * multiplier, uncertainties: [] };
}

function timeoutCommandBudget(
  words: readonly WordToken[],
  commandIndex: number,
  variables: ReadonlyMap<string, string | null>,
): BudgetAnalysis {
  let index = commandIndex + 1;
  let killGrace = ZERO;

  while (index < words.length) {
    const option = resolveWord(words[index], variables);
    if (option === null) {
      return uncertain("coreutils timeout uses dynamic options");
    }
    if (option === "--") {
      index += 1;
      break;
    }
    if (!option.startsWith("-")) break;
    if (["--preserve-status", "--foreground", "--verbose", "-v"].includes(option)) {
      index += 1;
      continue;
    }
    if (option === "--kill-after" || option === "-k") {
      killGrace = parseDuration(resolveWord(words[index + 1], variables), "timeout kill grace");
      index += 2;
      continue;
    }
    const killEquals = /^(?:--kill-after=|-k)(.+)$/u.exec(option);
    if (killEquals) {
      killGrace = parseDuration(killEquals[1], "timeout kill grace");
      index += 1;
      continue;
    }
    if (option === "--signal" || option === "-s") {
      if (resolveWord(words[index + 1], variables) === null) {
        return uncertain("coreutils timeout uses a dynamic or missing signal option");
      }
      index += 2;
      continue;
    }
    if (/^(?:--signal=|-s).+/u.test(option)) {
      index += 1;
      continue;
    }
    if (option === "--help" || option === "--version") return ZERO;
    return uncertain(`coreutils timeout uses unsupported option ${JSON.stringify(option)}`);
  }

  return sum([parseDuration(resolveWord(words[index], variables), "coreutils timeout"), killGrace]);
}

function readFlagDuration(
  words: readonly WordToken[],
  index: number,
  flag: "--timeout-seconds" | "--timeout",
  variables: ReadonlyMap<string, string | null>,
): Readonly<{ analysis: BudgetAnalysis; consumed: number }> | null {
  const token = resolveWord(words[index], variables);
  if (token === null) {
    const literal = words[index]?.segments.find((segment) => segment.kind === "literal");
    return literal?.kind === "literal" && literal.value.startsWith(flag)
      ? { analysis: uncertain(`${flag} uses a dynamic option or value`), consumed: 1 }
      : null;
  }
  if (token === flag) {
    const duration = resolveWord(words[index + 1], variables);
    if (!duration) return { analysis: uncertain(`${flag} has no value`), consumed: 1 };
    if (!/^\d+(?:\.\d+)?$/u.test(duration)) {
      return { analysis: uncertain(`${flag} has an invalid value`), consumed: 2 };
    }
    const amount = Number(duration);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { analysis: uncertain(`${flag} has an invalid value`), consumed: 2 };
    }
    return {
      analysis: { minutes: amount / (flag === "--timeout" ? 60_000 : 60), uncertainties: [] },
      consumed: 2,
    };
  }
  const prefix = `${flag}=`;
  if (!token.startsWith(prefix)) return null;
  const raw = token.slice(prefix.length);
  const amount = Number(raw);
  if (!/^\d+(?:\.\d+)?$/u.test(raw) || !Number.isFinite(amount) || amount <= 0) {
    return { analysis: uncertain(`${flag} uses a dynamic or invalid value`), consumed: 1 };
  }
  return {
    analysis: { minutes: amount / (flag === "--timeout" ? 60_000 : 60), uncertainties: [] },
    consumed: 1,
  };
}

function commandName(word: string): string {
  const pieces = word.split("/");
  return pieces[pieces.length - 1] as string;
}

function assignment(
  word: WordToken,
  variables: ReadonlyMap<string, string | null>,
): Readonly<{ name: string; value: string | null }> | null {
  let name = "";
  let foundEquals = false;
  const valueSegments: WordSegment[] = [];
  for (const segment of word.segments) {
    if (!foundEquals) {
      if (segment.kind !== "literal") return null;
      const equals = segment.value.indexOf("=");
      if (equals < 0) {
        name += segment.value;
        continue;
      }
      name += segment.value.slice(0, equals);
      appendLiteral(valueSegments, segment.value.slice(equals + 1));
      foundEquals = true;
    } else valueSegments.push(segment);
  }
  if (!foundEquals || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) return null;
  return { name, value: resolveSegments(valueSegments, variables) };
}

function unwrapCommand(
  words: readonly WordToken[],
  variables: ReadonlyMap<string, string | null>,
): number {
  let index = 0;
  while (index < words.length && assignment(words[index] as WordToken, variables)) index += 1;
  while (index < words.length) {
    const resolved = resolveWord(words[index], variables);
    if (resolved === null) break;
    const name = commandName(resolved);
    if (["!", "builtin", "command", "exec", "time"].includes(name)) {
      index += 1;
      continue;
    }
    if (name === "env") {
      index += 1;
      while (
        index < words.length &&
        ((resolveWord(words[index], variables) ?? "").startsWith("-") ||
          assignment(words[index] as WordToken, variables))
      ) {
        index += 1;
      }
      continue;
    }
    if (name === "sudo") {
      index += 1;
      while (index < words.length && (resolveWord(words[index], variables) ?? "").startsWith("-")) {
        const option = resolveWord(words[index], variables) as string;
        index += 1;
        if (["-u", "--user", "-g", "--group", "-h", "--host"].includes(option)) index += 1;
      }
      continue;
    }
    break;
  }
  return index;
}

function withoutEffects(words: readonly WordToken[]): readonly WordToken[] {
  return words.map((word) => ({ ...word, effects: [] }));
}

function analyzeCommand(
  words: readonly WordToken[],
  variables: Map<string, string | null>,
  depth: number,
): BudgetAnalysis {
  const effects = sum(words.flatMap((word) => word.effects));
  let assignmentCount = 0;
  const assignments: Array<{ name: string; value: string | null }> = [];
  while (assignmentCount < words.length) {
    const parsed = assignment(words[assignmentCount] as WordToken, variables);
    if (!parsed) break;
    assignments.push(parsed);
    assignmentCount += 1;
  }
  if (assignmentCount === words.length) {
    for (const parsed of assignments) variables.set(parsed.name, parsed.value);
    return effects;
  }

  const commandIndex = unwrapCommand(words, variables);
  const command = words[commandIndex];
  if (!command) return ZERO;
  const resolvedCommand = resolveWord(command, variables);
  if (resolvedCommand === null) {
    return sum([effects, uncertain("dynamic command position is not statically analyzable")]);
  }
  const name = commandName(resolvedCommand);
  if (["export", "readonly", "declare", "typeset", "local"].includes(name)) {
    for (const word of words.slice(commandIndex + 1)) {
      const parsed = assignment(word, variables);
      if (parsed) variables.set(parsed.name, parsed.value);
    }
    return effects;
  }
  if (name === "unset") {
    for (const word of words.slice(commandIndex + 1)) {
      const variable = resolveWord(word, variables);
      if (variable === null) variables.clear();
      else if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(variable)) variables.delete(variable);
    }
    return effects;
  }
  if (name === "read") {
    for (const word of words.slice(commandIndex + 1)) {
      const variable = resolveWord(word, variables);
      if (variable === null) variables.clear();
      else if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(variable)) variables.set(variable, null);
    }
    return effects;
  }
  if (name === "source" || name === ".") {
    variables.clear();
    return sum([effects, uncertain(`${name} evaluates a script that is not statically available`)]);
  }
  if (PROSE_COMMANDS.has(name)) return effects;
  if (TIMEOUT_COMMANDS.has(name)) {
    return sum([effects, timeoutCommandBudget(words, commandIndex, variables)]);
  }

  if (SHELL_COMMANDS.has(name)) {
    const commandFlag = words.findIndex(
      (word, index) =>
        index > commandIndex && /^-[A-Za-z]*c[A-Za-z]*$/u.test(resolveWord(word, variables) ?? ""),
    );
    if (commandFlag >= 0) {
      const script = words[commandFlag + 1];
      const resolvedScript = resolveWord(script, variables);
      if (resolvedScript === null)
        return sum([effects, uncertain(`${name} -c uses a dynamic script`)]);
      return sum([effects, analyzeShellTimeoutBudgetInternal(resolvedScript, depth + 1)]);
    }
    for (let index = commandIndex + 1; index < words.length; index += 1) {
      const argument = resolveWord(words[index], variables);
      if (argument === null) {
        return sum([effects, uncertain(`${name} uses dynamic evaluator arguments`)]);
      }
      if (argument === "<<<") {
        const script = resolveWord(words[index + 1], variables);
        return script === null
          ? sum([effects, uncertain(`${name} uses a dynamic here-string script`)])
          : sum([effects, analyzeShellTimeoutBudgetInternal(script, depth + 1)]);
      }
      if (argument.startsWith("<<<")) {
        return sum([effects, analyzeShellTimeoutBudgetInternal(argument.slice(3), depth + 1)]);
      }
      if (argument.startsWith("<<")) {
        return sum([effects, uncertain(`${name} evaluates a here-document body`)]);
      }
    }
  }

  if (name === "eval") {
    const evaluated = words.slice(commandIndex + 1).map((word) => resolveWord(word, variables));
    if (evaluated.some((word) => word === null)) {
      return sum([effects, uncertain("eval uses a dynamic script")]);
    }
    return sum([
      effects,
      analyzeShellTimeoutBudgetInternal((evaluated as string[]).join(" "), depth + 1),
    ]);
  }

  if (name === "retry") {
    let attempts: number | null = null;
    let ambiguousRetries = false;
    let nestedStart = commandIndex + 1;
    const first = resolveWord(words[nestedStart], variables);
    if (first && /^\d+$/u.test(first)) {
      attempts = Number(first);
      nestedStart += 1;
    } else {
      for (let index = nestedStart; index < words.length; index += 1) {
        const word = resolveWord(words[index], variables);
        if (word && ["--attempts", "-n"].includes(word)) {
          const value = resolveWord(words[index + 1], variables);
          if (value && /^\d+$/u.test(value)) {
            attempts = Number(value);
            nestedStart = index + 2;
          }
          break;
        }
        const equalsAttempts = word ? /^(?:--attempts=|-n)(\d+)$/u.exec(word) : null;
        if (equalsAttempts) {
          attempts = Number(equalsAttempts[1]);
          nestedStart = index + 1;
          break;
        }
        if (word === "--retries") {
          ambiguousRetries = true;
          nestedStart = index + 2;
          break;
        }
        if (word && /^--retries=\d+$/u.test(word)) {
          ambiguousRetries = true;
          nestedStart = index + 1;
          break;
        }
      }
    }
    const nested = analyzeCommand(
      withoutEffects(words.slice(nestedStart)),
      new Map(variables),
      depth,
    );
    if (ambiguousRetries && (nested.minutes > 0 || nested.uncertainties.length > 0)) {
      return sum([
        effects,
        uncertain(
          "retry --retries does not declare whether the value includes the first attempt",
          nested.minutes,
        ),
      ]);
    }
    if (attempts === null || attempts <= 0) {
      return nested.minutes > 0 || nested.uncertainties.length > 0
        ? sum([effects, uncertain("retry wrapper has an unknown attempt count", nested.minutes)])
        : effects;
    }
    return sum([effects, scaled(nested, attempts)]);
  }

  const analyses: BudgetAnalysis[] = [effects];
  for (let index = commandIndex + 1; index < words.length;) {
    const resolvedArgument = resolveWord(words[index], variables);
    if (
      resolvedArgument === null &&
      name === "bun" &&
      /^\d{5,}(?:\.\d+)?$/u.test(resolveWord(words[index + 1], variables) ?? "")
    ) {
      analyses.push(uncertain("bun uses a dynamic argument that may supply a timeout option"));
    }
    const seconds = readFlagDuration(words, index, "--timeout-seconds", variables);
    if (seconds) {
      analyses.push(seconds.analysis);
      index += seconds.consumed;
      continue;
    }
    const milliseconds = readFlagDuration(words, index, "--timeout", variables);
    if (milliseconds) {
      if (name !== "bun") {
        analyses.push(uncertain(`--timeout units are unknown for command ${JSON.stringify(name)}`));
      } else {
        analyses.push(milliseconds.analysis);
      }
      index += milliseconds.consumed;
      continue;
    }
    if (TIMEOUT_COMMANDS.has(resolveWord(words[index], variables) ?? "")) {
      analyses.push(
        uncertain(`timeout is nested behind unsupported wrapper ${JSON.stringify(name)}`),
      );
    }
    index += 1;
  }
  return sum(analyses);
}

function unsupportedControlFlow(tokens: readonly ShellToken[]): string | null {
  let atCommandBoundary = true;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as ShellToken;
    if (token.kind === "operator") {
      if (LIST_SEPARATORS.has(token.value) || ["|", "|&", "("].includes(token.value)) {
        atCommandBoundary = true;
      }
      continue;
    }
    if (atCommandBoundary && ["case", "select", "function"].includes(token.value)) {
      return `${token.value} control flow is not statically budgeted`;
    }
    if (
      atCommandBoundary &&
      tokens[index + 1]?.kind === "operator" &&
      tokens[index + 1]?.value === "(" &&
      tokens[index + 2]?.kind === "operator" &&
      tokens[index + 2]?.value === ")"
    ) {
      return "shell function calls can amplify timeout budgets";
    }
    atCommandBoundary = ["then", "do", "else", "elif"].includes(token.value);
  }
  return null;
}

class ShellBudgetParser {
  private index = 0;

  constructor(
    private readonly tokens: readonly ShellToken[],
    private readonly variables = new Map<string, string | null>(),
    private readonly depth = 0,
  ) {}

  parse(
    stopWords: ReadonlySet<string> = new Set(),
    stopOperators: ReadonlySet<string> = new Set(),
  ): BudgetAnalysis {
    const statements: BudgetAnalysis[] = [];
    while (this.index < this.tokens.length) {
      this.skipSeparators();
      const token = this.tokens[this.index];
      if (!token) break;
      if (token.kind === "word" && stopWords.has(token.value)) break;
      if (token.kind === "operator" && stopOperators.has(token.value)) break;
      if (token.kind === "operator" && token.value === ")") {
        this.index += 1;
        continue;
      }
      if (token.kind === "word" && token.value === "for") statements.push(this.parseFor());
      else if (token.kind === "word" && ["while", "until"].includes(token.value))
        statements.push(this.parseUnboundedLoop());
      else if (token.kind === "word" && token.value === "if") statements.push(this.parseIf());
      else if (token.kind === "operator" && token.value === "(")
        statements.push(this.parseSubshell());
      else statements.push(this.parsePipeline(stopWords));
    }
    return sum(statements);
  }

  private skipSeparators(): void {
    while (true) {
      const token = this.tokens[this.index];
      if (!token || token.kind !== "operator" || !LIST_SEPARATORS.has(token.value)) return;
      this.index += 1;
    }
  }

  private restoreVariables(snapshot: ReadonlyMap<string, string | null>): void {
    this.variables.clear();
    for (const [name, value] of snapshot) this.variables.set(name, value);
  }

  private mergeBranchVariables(
    entry: ReadonlyMap<string, string | null>,
    branches: readonly ReadonlyMap<string, string | null>[],
  ): void {
    const names = new Set([...entry.keys(), ...branches.flatMap((branch) => [...branch.keys()])]);
    this.variables.clear();
    for (const name of names) {
      const values = branches.map((branch) => (branch.has(name) ? branch.get(name) : undefined));
      const first = values[0];
      if (values.every((value) => value === first)) {
        if (first !== undefined) this.variables.set(name, first ?? null);
      } else this.variables.set(name, null);
    }
  }

  private parsePipeline(stopWords: ReadonlySet<string>): BudgetAnalysis {
    const commands: BudgetAnalysis[] = [];
    const commandWords: WordToken[][] = [];
    let words: WordToken[] = [];
    const flush = () => {
      if (words.length > 0) commandWords.push(words);
      words = [];
    };

    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index] as ShellToken;
      if (token.kind === "word" && words.length === 0 && stopWords.has(token.value)) break;
      if (token.kind === "operator") {
        if (token.value === "|" || token.value === "|&") {
          flush();
          this.index += 1;
          continue;
        }
        if (LIST_SEPARATORS.has(token.value) || token.value === ")") break;
      }
      if (token.kind === "word") words.push(token);
      this.index += 1;
    }
    flush();
    if (commandWords.length === 1) {
      commands.push(analyzeCommand(commandWords[0] as WordToken[], this.variables, this.depth));
    } else {
      for (const pipelineCommand of commandWords) {
        commands.push(analyzeCommand(pipelineCommand, new Map(this.variables), this.depth));
      }
    }
    return maximum(commands);
  }

  private parseFor(): BudgetAnalysis {
    const entryVariables = new Map(this.variables);
    this.index += 1;
    const variable = this.tokens[this.index];
    if (!variable || variable.kind !== "word") return uncertain("for loop has no variable");
    const variableName = resolveWord(variable, this.variables);
    this.index += 1;
    const iterations: WordToken[] = [];
    const maybeIn = this.tokens[this.index];
    if (maybeIn?.kind === "word" && maybeIn.value === "in") {
      this.index += 1;
      while (this.index < this.tokens.length) {
        const token = this.tokens[this.index] as ShellToken;
        if (token.kind === "operator" && (token.value === ";" || token.value === "\n")) break;
        if (token.kind === "word") iterations.push(token);
        else return uncertain("for loop uses unsupported iteration syntax");
        this.index += 1;
      }
    } else {
      return uncertain("for loop iteration count is implicit");
    }
    this.skipSeparators();
    const doToken = this.tokens[this.index];
    if (!doToken || doToken.kind !== "word" || doToken.value !== "do") {
      return uncertain("for loop has unsupported header syntax");
    }
    this.index += 1;
    // The loop variable changes before every body execution. Parsing the body
    // against a pre-loop value can therefore resolve a dynamic command to the
    // wrong executable and miss its timeout entirely.
    if (variableName && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(variableName)) {
      this.variables.set(variableName, null);
    } else {
      this.variables.clear();
    }
    const body = this.parse(new Set(["done"]));
    const bodyVariables = new Map(this.variables);
    if (this.tokens[this.index]?.kind === "word") this.index += 1;

    const iterationEffects = sum(iterations.flatMap((iteration) => iteration.effects));
    const resolvedIterations = iterations.map((iteration) =>
      resolveWord(iteration, entryVariables),
    );
    // Even a statically resolved unquoted expansion can undergo shell word
    // splitting or pathname expansion. Without quote provenance, only literal
    // iteration words have a statically knowable count.
    if (iterations.some((iteration) => iteration.dynamic)) {
      this.mergeBranchVariables(entryVariables, [entryVariables, bodyVariables]);
      return body.minutes > 0 || body.uncertainties.length > 0
        ? sum([iterationEffects, body, uncertain("for loop has a dynamic iteration count")])
        : iterationEffects;
    }
    if (
      resolvedIterations.some(
        (iteration) =>
          iteration !== null &&
          /[*?[\]{}]/u.test(iteration) &&
          !/^\{(-?\d+)\.\.(-?\d+)\}$/u.test(iteration),
      )
    ) {
      this.mergeBranchVariables(entryVariables, [entryVariables, bodyVariables]);
      return body.minutes > 0 || body.uncertainties.length > 0
        ? sum([
            iterationEffects,
            body,
            uncertain("for loop has a non-static expansion in its iteration list"),
          ])
        : iterationEffects;
    }
    let count = 0;
    for (const iteration of resolvedIterations as string[]) {
      const range = /^\{(-?\d+)\.\.(-?\d+)\}$/u.exec(iteration);
      if (range) count += Math.abs(Number(range[2]) - Number(range[1])) + 1;
      else count += 1;
    }
    if (count === 0) this.restoreVariables(entryVariables);
    return sum([iterationEffects, scaled(body, count)]);
  }

  private parseUnboundedLoop(): BudgetAnalysis {
    const kind = (this.tokens[this.index] as WordToken).value;
    this.index += 1;
    const conditionStart = this.index;
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index] as ShellToken;
      if (token.kind === "word" && token.value === "do") break;
      this.index += 1;
    }
    const conditionVariables = new Map(this.variables);
    const condition = new ShellBudgetParser(
      this.tokens.slice(conditionStart, this.index),
      conditionVariables,
      this.depth,
    ).parse();
    // A while/until condition always executes at least once, and its ordinary
    // shell assignments remain visible both to the body and after the loop.
    this.restoreVariables(conditionVariables);
    if (this.tokens[this.index]?.kind === "word") this.index += 1;
    const body = this.parse(new Set(["done"]));
    const bodyVariables = new Map(this.variables);
    this.mergeBranchVariables(conditionVariables, [conditionVariables, bodyVariables]);
    if (this.tokens[this.index]?.kind === "word") this.index += 1;
    const oneIteration = sum([condition, body]);
    return oneIteration.minutes > 0 || oneIteration.uncertainties.length > 0
      ? uncertain(
          `${kind} loop can amplify timeout budgets an unknown number of times`,
          oneIteration.minutes,
        )
      : ZERO;
  }

  private parseIf(): BudgetAnalysis {
    const entryVariables = new Map(this.variables);
    const branchVariables: Array<ReadonlyMap<string, string | null>> = [];
    let hasElse = false;
    let fallthroughVariables = new Map(entryVariables);
    this.index += 1;
    const conditionStart = this.index;
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index] as ShellToken;
      if (token.kind === "word" && token.value === "then") break;
      this.index += 1;
    }
    const firstConditionVariables = new Map(entryVariables);
    const conditions: BudgetAnalysis[] = [
      new ShellBudgetParser(
        this.tokens.slice(conditionStart, this.index),
        firstConditionVariables,
        this.depth,
      ).parse(),
    ];
    fallthroughVariables = firstConditionVariables;
    this.restoreVariables(firstConditionVariables);
    if (this.tokens[this.index]?.kind === "word") this.index += 1;
    const branches: BudgetAnalysis[] = [this.parse(new Set(["elif", "else", "fi"]))];
    branchVariables.push(new Map(this.variables));

    while (this.tokens[this.index]?.kind === "word") {
      const marker = (this.tokens[this.index] as WordToken).value;
      this.index += 1;
      if (marker === "fi") break;
      if (marker === "else") {
        hasElse = true;
        this.restoreVariables(fallthroughVariables);
        branches.push(this.parse(new Set(["fi"])));
        branchVariables.push(new Map(this.variables));
        if (this.tokens[this.index]?.kind === "word") this.index += 1;
        break;
      }
      this.restoreVariables(fallthroughVariables);
      const elifConditionStart = this.index;
      while (this.index < this.tokens.length) {
        const token = this.tokens[this.index] as ShellToken;
        if (token.kind === "word" && token.value === "then") break;
        this.index += 1;
      }
      const elifConditionVariables = new Map(fallthroughVariables);
      conditions.push(
        new ShellBudgetParser(
          this.tokens.slice(elifConditionStart, this.index),
          elifConditionVariables,
          this.depth,
        ).parse(),
      );
      fallthroughVariables = elifConditionVariables;
      this.restoreVariables(elifConditionVariables);
      if (this.tokens[this.index]?.kind === "word") this.index += 1;
      branches.push(this.parse(new Set(["elif", "else", "fi"])));
      branchVariables.push(new Map(this.variables));
    }
    if (!hasElse) branchVariables.push(fallthroughVariables);
    this.mergeBranchVariables(entryVariables, branchVariables);
    return sum([...conditions, maximum(branches)]);
  }

  private parseSubshell(): BudgetAnalysis {
    this.index += 1;
    const outerVariables = new Map(this.variables);
    const body = this.parse(new Set(), new Set([")"]));
    this.restoreVariables(outerVariables);
    if (this.tokens[this.index]?.kind === "operator" && this.tokens[this.index]?.value === ")") {
      this.index += 1;
    }
    return body;
  }
}

function analyzeShellTimeoutBudgetInternal(source: string, depth: number): BudgetAnalysis {
  if (depth > MAX_ANALYSIS_DEPTH) return uncertain("shell analysis nesting is too deep");
  const lexed = lexShell(source, depth);
  const parsed = new ShellBudgetParser(lexed.tokens, new Map(), depth).parse();
  const unsupported = unsupportedControlFlow(lexed.tokens);
  if (unsupported && (parsed.minutes > 0 || parsed.uncertainties.length > 0)) {
    return sum([parsed, lexed, uncertain(unsupported)]);
  }
  return sum([parsed, lexed]);
}

export function analyzeShellTimeoutBudget(source: string): BudgetAnalysis {
  return analyzeShellTimeoutBudgetInternal(source, 0);
}

export function analyzeStepTimeoutBudget(step: TimeoutStep): BudgetAnalysis {
  const cap = step["timeout-minutes"];
  if (cap !== undefined) {
    if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0) {
      return uncertain("step timeout-minutes is dynamic or invalid");
    }
    // The runner-enforced step cap bounds every nested command and retry, so
    // adding inner declarations would count the same wall-clock twice.
    return { minutes: cap, uncertainties: [] };
  }
  const run = String(step.run ?? "");
  if (step.shell && !/(?:^|\/)(?:ba|da|z)?sh(?:\s|$)/u.test(step.shell)) {
    const shellAnalysis = analyzeShellTimeoutBudget(run);
    // Do not apply POSIX-shell dynamic-command semantics to PowerShell or
    // another foreign grammar. A literal budget that this analyzer can prove
    // still fails closed because its units/ceiling are shell-dependent.
    return shellAnalysis.minutes > 0
      ? sum([
          shellAnalysis,
          uncertain(`timeout syntax in unsupported shell ${JSON.stringify(step.shell)}`),
        ])
      : ZERO;
  }
  return analyzeShellTimeoutBudget(run);
}
