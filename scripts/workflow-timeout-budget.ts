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
}>;

type OperatorToken = Readonly<{
  kind: "operator";
  value: string;
}>;

type ShellToken = WordToken | OperatorToken;

const ZERO: BudgetAnalysis = { minutes: 0, uncertainties: [] };
const LIST_SEPARATORS = new Set(["\n", ";", "&&", "||", "&"]);
const PROSE_COMMANDS = new Set(["echo", "printf"]);
const SHELL_COMMANDS = new Set(["bash", "dash", "sh", "zsh"]);

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

function looksLikeBudget(source: string): boolean {
  return /(?:^|[^\w])(?:--)?timeout(?:-seconds)?(?:\s|=|$)/u.test(source);
}

function looksLikeShellEvaluation(source: string): boolean {
  return /(?:^|[;&|\s])(?:\S*\/)?(?:bash|dash|sh|zsh)\s+(?:[^;\n]*\s)?-[A-Za-z]*c[A-Za-z]*(?:\s|$)/u.test(
    source,
  );
}

/**
 * Remove literal here-document bodies before tokenization. They are data, not
 * shell commands. Malformed declarations remain an explicit uncertainty.
 */
function hereDocumentsOnLine(line: string): Readonly<{
  declarations: readonly { delimiter: string; stripTabs: boolean }[];
  dynamic: boolean;
}> {
  const declarations: Array<{ delimiter: string; stripTabs: boolean }> = [];
  let dynamic = false;
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
    const delimiterQuote = line[cursor];
    if (delimiterQuote === "'" || delimiterQuote === '"') {
      cursor += 1;
      while (cursor < line.length && line[cursor] !== delimiterQuote) {
        const delimiterChar = line[cursor] as string;
        if (delimiterQuote === '"' && delimiterChar === "\\" && line[cursor + 1] !== undefined) {
          delimiter += line[(cursor += 1)] as string;
        } else {
          delimiter += delimiterChar;
        }
        cursor += 1;
      }
      if (line[cursor] !== delimiterQuote) dynamic = true;
    } else {
      while (cursor < line.length && !/[\s;&|()<>]/u.test(line[cursor] as string)) {
        const delimiterChar = line[cursor] as string;
        if (delimiterChar === "\\" && line[cursor + 1] !== undefined) {
          delimiter += line[(cursor += 1)] as string;
        } else {
          delimiter += delimiterChar;
        }
        cursor += 1;
      }
    }
    if (delimiter.length > 0 && !dynamic) declarations.push({ delimiter, stripTabs });
    else dynamic = true;
    index = Math.max(index + 1, cursor - 1);
    atWordBoundary = false;
  }
  return { declarations, dynamic };
}

function stripStaticHereDocuments(
  source: string,
): Readonly<{ input: string; uncertainties: readonly string[] }> {
  const lines = source.split("\n");
  const out: string[] = [];
  const pending: Array<{ delimiter: string; stripTabs: boolean }> = [];
  let dynamic = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    out.push(line);
    if (pending.length > 0) continue;

    const found = hereDocumentsOnLine(line);
    pending.push(...found.declarations);
    dynamic ||= found.dynamic;

    while (pending.length > 0 && index + 1 < lines.length) {
      const bodyLine = lines[(index += 1)] as string;
      const current = pending[0] as { delimiter: string; stripTabs: boolean };
      const candidate = current.stripTabs ? bodyLine.replace(/^\t+/u, "") : bodyLine;
      out.push(candidate === current.delimiter ? bodyLine : "");
      if (candidate === current.delimiter) pending.shift();
    }
  }
  return {
    input: out.join("\n"),
    uncertainties: dynamic || pending.length > 0 ? ["malformed here-document delimiter"] : [],
  };
}

function lexShell(source: string): BudgetAnalysis & Readonly<{ tokens: readonly ShellToken[] }> {
  const stripped = stripStaticHereDocuments(source);
  const input = stripped.input;
  const tokens: ShellToken[] = [];
  let value = "";
  let dynamic = false;
  let quote: "single" | "double" | null = null;

  const pushWord = () => {
    if (value.length === 0) return;
    tokens.push({ kind: "word", value, dynamic });
    value = "";
    dynamic = false;
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string;
    const next = input[index + 1];

    if (quote === "single") {
      if (char === "'") quote = null;
      else {
        if (char === "$" && next === "{" && input[index + 2] === "{") dynamic = true;
        value += char;
      }
      continue;
    }

    if (quote === "double") {
      if (char === '"') {
        quote = null;
      } else if (char === "\\" && next !== undefined) {
        if (next === "\n") index += 1;
        else if ('"\\$`'.includes(next)) value += input[(index += 1)] as string;
        else value += char;
      } else {
        if (char === "$" || char === "`") dynamic = true;
        value += char;
      }
      continue;
    }

    if (char === "\\") {
      if (next === "\n") index += 1;
      else if (next !== undefined) value += input[(index += 1)] as string;
      else value += char;
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
    if (char === "#" && value.length === 0) {
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
    if (char === "$" || char === "`") dynamic = true;

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
    value += char;
  }
  pushWord();

  const uncertainties: string[] = [...stripped.uncertainties];
  if (quote !== null && looksLikeBudget(input)) {
    uncertainties.push("unterminated shell quote around a timeout declaration");
  }
  return { minutes: 0, uncertainties, tokens };
}

function parseDuration(token: WordToken | undefined, context: string): BudgetAnalysis {
  if (!token) return uncertain(`${context} has no duration`);
  if (token.dynamic) return uncertain(`${context} uses a dynamic duration`);
  const match = /^(\d+(?:\.\d+)?)([smhd]?)$/u.exec(token.value);
  if (!match)
    return uncertain(`${context} has an unsupported duration ${JSON.stringify(token.value)}`);
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return uncertain(`${context} has a non-positive duration`);
  }
  const multiplier = { "": 1 / 60, s: 1 / 60, m: 1, h: 60, d: 1440 }[
    match[2] as "" | "s" | "m" | "h" | "d"
  ];
  return { minutes: amount * multiplier, uncertainties: [] };
}

function timeoutCommandBudget(words: readonly WordToken[], commandIndex: number): BudgetAnalysis {
  let index = commandIndex + 1;
  let killGrace = ZERO;

  while (index < words.length) {
    const option = words[index] as WordToken;
    if (option.dynamic && option.value.startsWith("-")) {
      return uncertain("coreutils timeout uses dynamic options");
    }
    if (option.value === "--") {
      index += 1;
      break;
    }
    if (!option.value.startsWith("-")) break;
    if (["--preserve-status", "--foreground", "--verbose", "-v"].includes(option.value)) {
      index += 1;
      continue;
    }
    if (option.value === "--kill-after" || option.value === "-k") {
      killGrace = parseDuration(words[index + 1], "timeout kill grace");
      index += 2;
      continue;
    }
    const killEquals = /^(?:--kill-after=|-k)(.+)$/u.exec(option.value);
    if (killEquals) {
      killGrace = parseDuration(
        { kind: "word", value: killEquals[1] as string, dynamic: option.dynamic },
        "timeout kill grace",
      );
      index += 1;
      continue;
    }
    if (option.value === "--signal" || option.value === "-s") {
      if (!words[index + 1] || (words[index + 1] as WordToken).dynamic) {
        return uncertain("coreutils timeout uses a dynamic or missing signal option");
      }
      index += 2;
      continue;
    }
    if (/^(?:--signal=|-s).+/u.test(option.value)) {
      index += 1;
      continue;
    }
    if (option.value === "--help" || option.value === "--version") return ZERO;
    return uncertain(`coreutils timeout uses unsupported option ${JSON.stringify(option.value)}`);
  }

  return sum([parseDuration(words[index], "coreutils timeout"), killGrace]);
}

function readFlagDuration(
  words: readonly WordToken[],
  index: number,
  flag: "--timeout-seconds" | "--timeout",
): Readonly<{ analysis: BudgetAnalysis; consumed: number }> | null {
  const token = words[index] as WordToken;
  if (token.value === flag) {
    const duration = words[index + 1];
    if (!duration) return { analysis: uncertain(`${flag} has no value`), consumed: 1 };
    if (duration.dynamic) {
      return { analysis: uncertain(`${flag} uses a dynamic value`), consumed: 2 };
    }
    if (!/^\d+(?:\.\d+)?$/u.test(duration.value)) {
      return { analysis: uncertain(`${flag} has an invalid value`), consumed: 2 };
    }
    const amount = Number(duration.value);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { analysis: uncertain(`${flag} has an invalid value`), consumed: 2 };
    }
    return {
      analysis: { minutes: amount / (flag === "--timeout" ? 60_000 : 60), uncertainties: [] },
      consumed: 2,
    };
  }
  const prefix = `${flag}=`;
  if (!token.value.startsWith(prefix)) return null;
  const raw = token.value.slice(prefix.length);
  const amount = Number(raw);
  if (token.dynamic || !/^\d+(?:\.\d+)?$/u.test(raw) || !Number.isFinite(amount) || amount <= 0) {
    return { analysis: uncertain(`${flag} uses a dynamic or invalid value`), consumed: 1 };
  }
  return {
    analysis: { minutes: amount / (flag === "--timeout" ? 60_000 : 60), uncertainties: [] },
    consumed: 1,
  };
}

function commandName(word: WordToken): string {
  const pieces = word.value.split("/");
  return pieces[pieces.length - 1] as string;
}

function isAssignment(word: WordToken): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word.value);
}

function unwrapCommand(words: readonly WordToken[]): number {
  let index = 0;
  while (index < words.length && isAssignment(words[index] as WordToken)) index += 1;
  while (index < words.length) {
    const name = commandName(words[index] as WordToken);
    if (["!", "builtin", "command", "exec", "time"].includes(name)) {
      index += 1;
      continue;
    }
    if (name === "env") {
      index += 1;
      while (
        index < words.length &&
        ((words[index] as WordToken).value.startsWith("-") ||
          isAssignment(words[index] as WordToken))
      ) {
        index += 1;
      }
      continue;
    }
    if (name === "sudo") {
      index += 1;
      while (index < words.length && (words[index] as WordToken).value.startsWith("-")) {
        const option = (words[index] as WordToken).value;
        index += 1;
        if (["-u", "--user", "-g", "--group", "-h", "--host"].includes(option)) index += 1;
      }
      continue;
    }
    break;
  }
  return index;
}

function analyzeCommand(words: readonly WordToken[]): BudgetAnalysis {
  const commandIndex = unwrapCommand(words);
  const command = words[commandIndex];
  if (!command) return ZERO;
  if (command.dynamic) {
    return words.some((word) => looksLikeBudget(word.value))
      ? uncertain("dynamic command contains a timeout declaration")
      : ZERO;
  }
  const name = commandName(command);
  if (PROSE_COMMANDS.has(name)) return ZERO;
  if (name === "timeout") return timeoutCommandBudget(words, commandIndex);

  if (SHELL_COMMANDS.has(name)) {
    const commandFlag = words.findIndex(
      (word, index) => index > commandIndex && /^-[A-Za-z]*c[A-Za-z]*$/u.test(word.value),
    );
    if (commandFlag >= 0) {
      const script = words[commandFlag + 1];
      if (!script || script.dynamic) return uncertain(`${name} -c uses a dynamic script`);
      return analyzeShellTimeoutBudget(script.value);
    }
  }

  if (name === "retry") {
    let attempts: number | null = null;
    let ambiguousRetries = false;
    let nestedStart = commandIndex + 1;
    const first = words[nestedStart];
    if (first && /^\d+$/u.test(first.value) && !first.dynamic) {
      attempts = Number(first.value);
      nestedStart += 1;
    } else {
      for (let index = nestedStart; index < words.length; index += 1) {
        const word = words[index] as WordToken;
        if (["--attempts", "-n"].includes(word.value)) {
          const value = words[index + 1];
          if (value && /^\d+$/u.test(value.value) && !value.dynamic) {
            attempts = Number(value.value);
            nestedStart = index + 2;
          }
          break;
        }
        const equalsAttempts = /^(?:--attempts=|-n)(\d+)$/u.exec(word.value);
        if (equalsAttempts && !word.dynamic) {
          attempts = Number(equalsAttempts[1]);
          nestedStart = index + 1;
          break;
        }
        if (word.value === "--retries") {
          ambiguousRetries = true;
          nestedStart = index + 2;
          break;
        }
        if (/^--retries=\d+$/u.test(word.value)) {
          ambiguousRetries = true;
          nestedStart = index + 1;
          break;
        }
      }
    }
    const nested = analyzeCommand(words.slice(nestedStart));
    if (ambiguousRetries && (nested.minutes > 0 || nested.uncertainties.length > 0)) {
      return uncertain(
        "retry --retries does not declare whether the value includes the first attempt",
        nested.minutes,
      );
    }
    if (attempts === null || attempts <= 0) {
      return nested.minutes > 0 || nested.uncertainties.length > 0
        ? uncertain("retry wrapper has an unknown attempt count", nested.minutes)
        : ZERO;
    }
    return scaled(nested, attempts);
  }

  const analyses: BudgetAnalysis[] = [];
  for (let index = commandIndex + 1; index < words.length;) {
    const seconds = readFlagDuration(words, index, "--timeout-seconds");
    if (seconds) {
      analyses.push(seconds.analysis);
      index += seconds.consumed;
      continue;
    }
    const milliseconds = readFlagDuration(words, index, "--timeout");
    if (milliseconds) {
      if (name !== "bun") {
        analyses.push(uncertain(`--timeout units are unknown for command ${JSON.stringify(name)}`));
      } else {
        analyses.push(milliseconds.analysis);
      }
      index += milliseconds.consumed;
      continue;
    }
    if ((words[index] as WordToken).value === "timeout") {
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

  constructor(private readonly tokens: readonly ShellToken[]) {}

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
        statements.push(uncertain("unmatched closing parenthesis in timeout-bearing shell"));
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

  private parsePipeline(stopWords: ReadonlySet<string>): BudgetAnalysis {
    const commands: BudgetAnalysis[] = [];
    let words: WordToken[] = [];
    const flush = () => {
      if (words.length > 0) commands.push(analyzeCommand(words));
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
    return maximum(commands);
  }

  private parseFor(): BudgetAnalysis {
    this.index += 1;
    const variable = this.tokens[this.index];
    if (!variable || variable.kind !== "word") return uncertain("for loop has no variable");
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
    const body = this.parse(new Set(["done"]));
    if (this.tokens[this.index]?.kind === "word") this.index += 1;

    if (iterations.some((iteration) => iteration.dynamic)) {
      return body.minutes > 0 || body.uncertainties.length > 0
        ? uncertain("for loop has a dynamic iteration count", body.minutes)
        : ZERO;
    }
    if (
      iterations.some(
        (iteration) =>
          /[*?[\]{}]/u.test(iteration.value) && !/^\{(-?\d+)\.\.(-?\d+)\}$/u.test(iteration.value),
      )
    ) {
      return body.minutes > 0 || body.uncertainties.length > 0
        ? uncertain("for loop has a non-static expansion in its iteration list", body.minutes)
        : ZERO;
    }
    let count = 0;
    for (const iteration of iterations) {
      const range = /^\{(-?\d+)\.\.(-?\d+)\}$/u.exec(iteration.value);
      if (range) count += Math.abs(Number(range[2]) - Number(range[1])) + 1;
      else count += 1;
    }
    return scaled(body, count);
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
    const condition = new ShellBudgetParser(this.tokens.slice(conditionStart, this.index)).parse();
    if (this.tokens[this.index]?.kind === "word") this.index += 1;
    const body = this.parse(new Set(["done"]));
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
    this.index += 1;
    const conditionStart = this.index;
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index] as ShellToken;
      if (token.kind === "word" && token.value === "then") break;
      this.index += 1;
    }
    const conditions: BudgetAnalysis[] = [
      new ShellBudgetParser(this.tokens.slice(conditionStart, this.index)).parse(),
    ];
    if (this.tokens[this.index]?.kind === "word") this.index += 1;
    const branches: BudgetAnalysis[] = [this.parse(new Set(["elif", "else", "fi"]))];

    while (this.tokens[this.index]?.kind === "word") {
      const marker = (this.tokens[this.index] as WordToken).value;
      this.index += 1;
      if (marker === "fi") break;
      if (marker === "else") {
        branches.push(this.parse(new Set(["fi"])));
        if (this.tokens[this.index]?.kind === "word") this.index += 1;
        break;
      }
      const elifConditionStart = this.index;
      while (this.index < this.tokens.length) {
        const token = this.tokens[this.index] as ShellToken;
        if (token.kind === "word" && token.value === "then") break;
        this.index += 1;
      }
      conditions.push(
        new ShellBudgetParser(this.tokens.slice(elifConditionStart, this.index)).parse(),
      );
      if (this.tokens[this.index]?.kind === "word") this.index += 1;
      branches.push(this.parse(new Set(["elif", "else", "fi"])));
    }
    return sum([...conditions, maximum(branches)]);
  }

  private parseSubshell(): BudgetAnalysis {
    this.index += 1;
    const body = this.parse(new Set(), new Set([")"]));
    if (this.tokens[this.index]?.kind === "operator" && this.tokens[this.index]?.value === ")") {
      this.index += 1;
    }
    return body;
  }
}

export function analyzeShellTimeoutBudget(source: string): BudgetAnalysis {
  if (!looksLikeBudget(source) && !looksLikeShellEvaluation(source)) return ZERO;
  const lexed = lexShell(source);
  const unsupported = unsupportedControlFlow(lexed.tokens);
  if (unsupported) {
    return sum([uncertain(unsupported), { minutes: 0, uncertainties: lexed.uncertainties }]);
  }
  const parsed = new ShellBudgetParser(lexed.tokens).parse();
  return sum([parsed, { minutes: 0, uncertainties: lexed.uncertainties }]);
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
    return looksLikeBudget(run)
      ? uncertain(`timeout syntax in unsupported shell ${JSON.stringify(step.shell)}`)
      : ZERO;
  }
  return analyzeShellTimeoutBudget(run);
}
