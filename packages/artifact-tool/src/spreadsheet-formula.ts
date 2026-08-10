import {
  EXCEL_MAX_COLUMNS,
  EXCEL_MAX_ROWS,
  columnIndexToName,
  columnNameToIndex,
  formatCellAddress,
  parseCellAddress,
  type CellAddress,
} from "./spreadsheet-address";
import { ArtifactLimitError } from "./errors";
import type { FormulaErrorValue, FormulaResult } from "./spreadsheet-types";

type Scalar = FormulaResult;
type Matrix = Scalar[][];
type Evaluated = Scalar | Matrix;
type FormulaPunctuation = "(" | ")" | "," | ":" | "!";

export type FormulaReference = {
  sheetName: string | null;
  start: CellAddress;
  end: CellAddress;
};
export type FormulaEvaluationContext = {
  currentSheetName: string;
  getCell: (sheetName: string, address: CellAddress) => FormulaResult;
  /** Reuse one budget across recursively evaluated dependency formulas. */
  budget?: FormulaEvaluationBudget;
  /** Applied only when `budget` is omitted. */
  limits?: Partial<FormulaEvaluationLimits>;
};

export type FormulaEvaluationLimits = {
  maxFormulaBytes: number;
  maxTokens: number;
  maxNestingDepth: number;
  maxFunctionArguments: number;
  maxRangeCells: number;
  maxCellReads: number;
  maxOperations: number;
  maxDependencyDepth: number;
  maxResultStringChars: number;
};

/** Conservative reference-engine boundaries. Native kernels must enforce equivalent or tighter caps. */
export const DEFAULT_FORMULA_LIMITS: Readonly<FormulaEvaluationLimits> = Object.freeze({
  maxFormulaBytes: 8_192,
  maxTokens: 4_096,
  maxNestingDepth: 64,
  maxFunctionArguments: 255,
  maxRangeCells: 100_000,
  maxCellReads: 100_000,
  maxOperations: 100_000,
  maxDependencyDepth: 256,
  maxResultStringChars: 32_767,
});

const activeFormulaBudgets = new WeakSet<FormulaEvaluationBudget>();

/**
 * Functions implemented by the bounded reference evaluator. Office codecs use the same
 * allowlist so an imported/exported formula cannot become an execution channel that OpenGeni
 * itself never parsed (for example HYPERLINK, DDE, external-workbook, or data-fetch functions).
 */
const SUPPORTED_FORMULA_FUNCTIONS = new Set([
  "SUM",
  "AVERAGE",
  "MIN",
  "MAX",
  "COUNT",
  "COUNTA",
  "IF",
  "IFERROR",
  "AND",
  "OR",
  "NOT",
  "ABS",
  "ROUND",
  "ROUNDUP",
  "ROUNDDOWN",
  "POWER",
  "SQRT",
  "LEN",
  "LOWER",
  "UPPER",
  "TRIM",
  "LEFT",
  "RIGHT",
  "MID",
  "CONCAT",
  "DATE",
  "YEAR",
  "MONTH",
  "DAY",
  "INDEX",
  "MATCH",
  "XLOOKUP",
]);

/** Explicit, shareable fuel for one root formula evaluation. */
export class FormulaEvaluationBudget {
  readonly limits: Readonly<FormulaEvaluationLimits>;
  private operationsUsed = 0;
  private cellReadsUsed = 0;

  constructor(overrides: Partial<FormulaEvaluationLimits> = {}) {
    for (const name of Object.keys(overrides)) {
      if (!Object.hasOwn(DEFAULT_FORMULA_LIMITS, name)) {
        throw new TypeError(`Unknown formula limit: ${name}`);
      }
    }
    const limits = { ...DEFAULT_FORMULA_LIMITS, ...overrides };
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive safe integer`);
      }
      const hardMaximum = DEFAULT_FORMULA_LIMITS[name as keyof FormulaEvaluationLimits];
      if (value > hardMaximum) {
        throw new TypeError(`${name} cannot exceed the hard maximum (${hardMaximum})`);
      }
    }
    this.limits = Object.freeze(limits);
  }

  consumeOperations(count = 1): void {
    const next = checkedFuelTotal(this.operationsUsed, count);
    if (next > this.limits.maxOperations) {
      throw new ArtifactLimitError(
        "formula evaluation operations",
        next,
        this.limits.maxOperations,
      );
    }
    this.operationsUsed = next;
  }

  consumeCellReads(count: number): void {
    const next = checkedFuelTotal(this.cellReadsUsed, count);
    if (next > this.limits.maxCellReads) {
      throw new ArtifactLimitError("formula dependency reads", next, this.limits.maxCellReads);
    }
    this.cellReadsUsed = next;
  }

  assertDependencyDepth(depth: number): void {
    if (depth > this.limits.maxDependencyDepth) {
      throw new ArtifactLimitError(
        "formula dependency depth",
        depth,
        this.limits.maxDependencyDepth,
      );
    }
  }

  get usage(): Readonly<{ operations: number; cellReads: number }> {
    return { operations: this.operationsUsed, cellReads: this.cellReadsUsed };
  }

  get operationCount(): number {
    return this.operationsUsed;
  }

  get cellReadCount(): number {
    return this.cellReadsUsed;
  }

  /**
   * Reuse this meter for one independent root without exposing a reset primitive. Re-entry is
   * rejected, including from a hostile `getCell` callback during `evaluateFormula`.
   */
  runIsolatedRoot<T>(evaluate: (budget: FormulaEvaluationBudget) => T): T {
    if (activeFormulaBudgets.has(this)) {
      throw new Error("Cannot reset formula fuel during an active root evaluation");
    }
    this.operationsUsed = 0;
    this.cellReadsUsed = 0;
    activeFormulaBudgets.add(this);
    try {
      return evaluate(this);
    } finally {
      activeFormulaBudgets.delete(this);
    }
  }

  /**
   * Activate one trusted batch while retaining an independent fuel counter for every root.
   * The scoped runner expires with the batch and cannot be used for active-root re-entry.
   */
  runIsolatedRoots<T>(
    evaluateBatch: (runRoot: <R>(evaluate: (budget: FormulaEvaluationBudget) => R) => R) => T,
  ): T {
    if (activeFormulaBudgets.has(this)) {
      throw new Error("Cannot reset formula fuel during an active root evaluation");
    }
    let open = true;
    let rootActive = false;
    activeFormulaBudgets.add(this);
    const runRoot = <R>(evaluate: (budget: FormulaEvaluationBudget) => R): R => {
      if (!open || !activeFormulaBudgets.has(this)) {
        throw new Error("Formula root batch is no longer active");
      }
      if (rootActive) {
        throw new Error("Cannot reset formula fuel during an active root evaluation");
      }
      this.operationsUsed = 0;
      this.cellReadsUsed = 0;
      rootActive = true;
      try {
        return evaluate(this);
      } finally {
        rootActive = false;
      }
    };
    try {
      return evaluateBatch(runRoot);
    } finally {
      open = false;
      activeFormulaBudgets.delete(this);
    }
  }
}

class FormulaFault extends Error {
  readonly code: FormulaErrorValue;

  constructor(code: FormulaErrorValue) {
    super(code);
    this.code = code;
  }
}

type Token =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "word"; value: string }
  | { type: "cell"; value: string }
  | { type: "error"; value: FormulaErrorValue }
  | { type: "operator"; value: string }
  | { type: "punctuation"; value: FormulaPunctuation };

export function evaluateFormula(formula: string, context: FormulaEvaluationContext): FormulaResult {
  const budget = context.budget ?? new FormulaEvaluationBudget(context.limits);
  const ownsBudgetActivation = !activeFormulaBudgets.has(budget);
  if (ownsBudgetActivation) activeFormulaBudgets.add(budget);
  try {
    const parser = new FormulaParser(formula, context, budget);
    return boundedScalar(scalar(parser.parse()), budget.limits.maxResultStringChars);
  } catch (cause) {
    if (cause instanceof FormulaFault) return cause.code;
    if (cause instanceof ArtifactLimitError) throw cause;
    return "#VALUE!";
  } finally {
    if (ownsBudgetActivation) activeFormulaBudgets.delete(budget);
  }
}

/** Validate resource bounds without materializing ranges or reading workbook cells. */
export function validateFormulaLimits(
  formula: string,
  limits: Partial<FormulaEvaluationLimits> = {},
): void {
  const budget = new FormulaEvaluationBudget(limits);
  try {
    new FormulaParser(
      formula,
      { currentSheetName: "Validation", getCell: () => null },
      budget,
      true,
    ).parse();
  } catch (cause) {
    // Spreadsheet syntax faults remain ordinary formula values; resource-limit faults do not.
    if (cause instanceof FormulaFault) return;
    throw cause;
  }
}

/**
 * Fail closed unless the complete formula is valid reference-engine syntax and every function
 * belongs to the explicit bounded allowlist. Unlike `validateFormulaLimits`, syntax faults are
 * rejected instead of being treated as ordinary spreadsheet error values.
 */
export function validateSupportedFormula(
  formula: string,
  limits: Partial<FormulaEvaluationLimits> = {},
): void {
  const budget = new FormulaEvaluationBudget(limits);
  try {
    new FormulaParser(
      formula,
      { currentSheetName: "Validation", getCell: () => null },
      budget,
      true,
      true,
    ).parse();
  } catch (cause) {
    if (cause instanceof ArtifactLimitError) throw cause;
    throw new TypeError("Formula contains unsupported syntax or functions", { cause });
  }
}

export function referencesInFormula(formula: string): FormulaReference[] {
  assertFormulaByteLimit(formula, DEFAULT_FORMULA_LIMITS.maxFormulaBytes);
  const references: FormulaReference[] = [];
  const expression = formula.startsWith("=") ? formula.slice(1) : formula;
  forEachFormulaCode(expression, (code) => {
    const pattern =
      /(^|[^A-Za-z0-9_.])(?:(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!)?(\$?[A-Za-z]{1,3}\$?[1-9]\d*)(?::(\$?[A-Za-z]{1,3}\$?[1-9]\d*))?(?![A-Za-z0-9_.(])/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code))) {
      try {
        const start = parseCellAddress(match[4]!);
        const end = match[5] ? parseCellAddress(match[5]) : start;
        references.push({
          sheetName: match[2]?.replaceAll("''", "'") ?? match[3] ?? null,
          start: {
            row: Math.min(start.row, end.row),
            col: Math.min(start.col, end.col),
          },
          end: {
            row: Math.max(start.row, end.row),
            col: Math.max(start.col, end.col),
          },
        });
      } catch {
        // Invalid/out-of-bounds A1-like identifiers are not valid precedents.
      }
    }
  });
  return references;
}

export function translateFormula(formula: string, rowDelta: number, colDelta: number): string {
  assertFormulaByteLimit(formula, DEFAULT_FORMULA_LIMITS.maxFormulaBytes);
  const translated = mapFormulaCode(formula, (code) =>
    code.replace(
      /(^|[^A-Za-z0-9_.])((?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d*)(?![A-Za-z0-9_.(])/g,
      (
        _full,
        leading: string,
        sheetPrefix: string | undefined,
        absoluteCol: string,
        colName: string,
        absoluteRow: string,
        rowText: string,
      ) => {
        const col = columnNameToIndex(colName);
        const row = Number(rowText) - 1;
        const nextCol = absoluteCol ? col : col + colDelta;
        const nextRow = absoluteRow ? row : row + rowDelta;
        if (
          nextCol < 0 ||
          nextCol >= EXCEL_MAX_COLUMNS ||
          nextRow < 0 ||
          nextRow >= EXCEL_MAX_ROWS
        ) {
          return `${leading}#REF!`;
        }
        return `${leading}${sheetPrefix ?? ""}${absoluteCol}${columnIndexToName(nextCol)}${absoluteRow}${nextRow + 1}`;
      },
    ),
  );
  assertFormulaByteLimit(translated, DEFAULT_FORMULA_LIMITS.maxFormulaBytes);
  return translated;
}

export function formulaFromR1C1(formula: string, anchor: CellAddress): string {
  assertFormulaByteLimit(formula, DEFAULT_FORMULA_LIMITS.maxFormulaBytes);
  const translated = mapFormulaCode(formula, (code) =>
    code.replace(
      /(^|[^A-Za-z0-9_.])((?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?R(?:\[(-?\d+)\]|([1-9]\d*))?C(?:\[(-?\d+)\]|([1-9]\d*))?(?![A-Za-z0-9_.])/gi,
      (
        _full,
        leading: string,
        sheetPrefix: string | undefined,
        relativeRow: string | undefined,
        absoluteRow: string | undefined,
        relativeCol: string | undefined,
        absoluteCol: string | undefined,
      ) => {
        const row =
          absoluteRow === undefined
            ? anchor.row + Number(relativeRow ?? 0)
            : Number(absoluteRow) - 1;
        const col =
          absoluteCol === undefined
            ? anchor.col + Number(relativeCol ?? 0)
            : Number(absoluteCol) - 1;
        if (row < 0 || row >= EXCEL_MAX_ROWS || col < 0 || col >= EXCEL_MAX_COLUMNS) {
          throw new Error(
            `R1C1 reference resolves outside worksheet bounds at ${formatCellAddress(anchor)}`,
          );
        }
        return `${leading}${sheetPrefix ?? ""}${absoluteCol === undefined ? "" : "$"}${columnIndexToName(col)}${absoluteRow === undefined ? "" : "$"}${row + 1}`;
      },
    ),
  );
  assertFormulaByteLimit(translated, DEFAULT_FORMULA_LIMITS.maxFormulaBytes);
  return translated;
}

export function formulaToR1C1(formula: string, anchor: CellAddress): string {
  assertFormulaByteLimit(formula, DEFAULT_FORMULA_LIMITS.maxFormulaBytes);
  const translated = mapFormulaCode(formula, (code) =>
    code.replace(
      /(^|[^A-Za-z0-9_.])((?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d*)(?![A-Za-z0-9_.(])/g,
      (
        _full,
        leading: string,
        sheetPrefix: string | undefined,
        absoluteCol: string,
        colName: string,
        absoluteRow: string,
        rowText: string,
      ) => {
        const row = Number(rowText) - 1;
        const col = columnNameToIndex(colName);
        const rowReference = absoluteRow
          ? `R${row + 1}`
          : row === anchor.row
            ? "R"
            : `R[${row - anchor.row}]`;
        const colReference = absoluteCol
          ? `C${col + 1}`
          : col === anchor.col
            ? "C"
            : `C[${col - anchor.col}]`;
        return `${leading}${sheetPrefix ?? ""}${rowReference}${colReference}`;
      },
    ),
  );
  assertFormulaByteLimit(translated, DEFAULT_FORMULA_LIMITS.maxFormulaBytes);
  return translated;
}

class FormulaParser {
  private readonly tokens: Token[];
  private index = 0;
  private nestingDepth = 0;

  constructor(
    formula: string,
    private readonly context: FormulaEvaluationContext,
    private readonly budget: FormulaEvaluationBudget,
    private readonly validateOnly = false,
    private readonly requireSupportedSyntax = false,
  ) {
    assertFormulaByteLimit(formula, budget.limits.maxFormulaBytes);
    this.tokens = tokenize(
      formula.startsWith("=") ? formula.slice(1) : formula,
      budget.limits.maxTokens,
    );
  }

  parse(): Evaluated {
    const value = this.comparison();
    if (this.peek()) throw new FormulaFault("#VALUE!");
    return value;
  }

  private comparison(): Evaluated {
    let left = this.concat();
    while (this.isOperator("=", "<>", "<", ">", "<=", ">=")) {
      const operator = (this.consume() as { value: string }).value;
      const right = this.concat();
      left = calculate(left, right, (a, b) => compare(a, b, operator));
    }
    return left;
  }

  private concat(): Evaluated {
    let left = this.additive();
    while (this.isOperator("&")) {
      this.consume();
      const right = this.additive();
      left = calculate(left, right, (a, b) =>
        concatenateText([text(a, this.budget), text(b, this.budget)], this.budget),
      );
    }
    return left;
  }

  private additive(): Evaluated {
    let left = this.multiplicative();
    while (this.isOperator("+", "-")) {
      const operator = (this.consume() as { value: string }).value;
      const right = this.multiplicative();
      left = calculate(left, right, (a, b) =>
        operator === "+" ? numeric(a) + numeric(b) : numeric(a) - numeric(b),
      );
    }
    return left;
  }

  private multiplicative(): Evaluated {
    let left = this.power();
    while (this.isOperator("*", "/")) {
      const operator = (this.consume() as { value: string }).value;
      const right = this.power();
      left = calculate(left, right, (a, b) => {
        const divisor = numeric(b);
        if (operator === "/" && divisor === 0) throw new FormulaFault("#DIV/0!");
        return operator === "*" ? numeric(a) * divisor : numeric(a) / divisor;
      });
    }
    return left;
  }

  private power(): Evaluated {
    let left = this.unary();
    if (this.isOperator("^")) {
      this.consume();
      const right = this.withNesting(() => this.power());
      left = calculate(left, right, (a, b) => finiteNumber(Math.pow(numeric(a), numeric(b))));
    }
    return left;
  }

  private unary(): Evaluated {
    if (this.isOperator("+")) {
      this.consume();
      return calculateUnary(
        this.withNesting(() => this.unary()),
        numeric,
      );
    }
    if (this.isOperator("-")) {
      this.consume();
      return calculateUnary(
        this.withNesting(() => this.unary()),
        (value) => -numeric(value),
      );
    }
    const value = this.primary();
    if (this.isOperator("%")) {
      this.consume();
      return calculateUnary(value, (item) => numeric(item) / 100);
    }
    return value;
  }

  private primary(): Evaluated {
    const token = this.consume();
    if (!token) throw new FormulaFault("#VALUE!");
    if (token.type === "number" || token.type === "string" || token.type === "error")
      return boundedScalar(token.value, this.budget.limits.maxResultStringChars);
    if (token.type === "punctuation" && token.value === "(") {
      const value = this.withNesting(() => this.comparison());
      this.expectPunctuation(")");
      return value;
    }
    if (token.type === "word") {
      if (this.isPunctuation("!")) {
        if (
          this.requireSupportedSyntax &&
          (token.value.length > 31 ||
            [...token.value].some((character) => "[]:*?/\\".includes(character)))
        ) {
          throw new FormulaFault("#REF!");
        }
        this.consume();
        const cell = this.consume();
        if (!cell || cell.type !== "cell") throw new FormulaFault("#REF!");
        return this.reference(token.value, cell.value);
      }
      if (this.isPunctuation("(")) return this.functionCall(token.value);
      const upper = token.value.toUpperCase();
      if (upper === "TRUE") return true;
      if (upper === "FALSE") return false;
      if (this.requireSupportedSyntax) throw new FormulaFault("#NAME?");
      return "#NAME?";
    }
    if (token.type === "cell") return this.reference(this.context.currentSheetName, token.value);
    throw new FormulaFault("#VALUE!");
  }

  private reference(sheetName: string, startAddress: string): Evaluated {
    let start: CellAddress;
    try {
      start = parseCellAddress(startAddress);
    } catch {
      return "#REF!";
    }
    if (!this.isPunctuation(":")) {
      if (this.validateOnly) return null;
      this.budget.consumeCellReads(1);
      return boundedScalar(
        this.context.getCell(sheetName, start),
        this.budget.limits.maxResultStringChars,
      );
    }
    this.consume();
    const endToken = this.consume();
    if (!endToken || endToken.type !== "cell") throw new FormulaFault("#REF!");
    let end: CellAddress;
    try {
      end = parseCellAddress(endToken.value);
    } catch {
      return "#REF!";
    }
    const startRow = Math.min(start.row, end.row);
    const endRow = Math.max(start.row, end.row);
    const startCol = Math.min(start.col, end.col);
    const endCol = Math.max(start.col, end.col);
    const rowCount = endRow - startRow + 1;
    const colCount = endCol - startCol + 1;
    const rangeCells = rowCount * colCount;
    if (rangeCells > this.budget.limits.maxRangeCells) {
      throw new ArtifactLimitError(
        "formula range cells",
        rangeCells,
        this.budget.limits.maxRangeCells,
      );
    }
    if (this.validateOnly) return null;
    // Charge the complete range before allocating a matrix or invoking even one dependency read.
    this.budget.consumeCellReads(rangeCells);
    const values: Matrix = [];
    for (let row = startRow; row <= endRow; row += 1) {
      const rowValues: Scalar[] = [];
      for (let col = startCol; col <= endCol; col += 1) {
        rowValues.push(
          boundedScalar(
            this.context.getCell(sheetName, { row, col }),
            this.budget.limits.maxResultStringChars,
          ),
        );
      }
      values.push(rowValues);
    }
    return values;
  }

  private functionCall(name: string): Evaluated {
    this.expectPunctuation("(");
    const args: Evaluated[] = [];
    if (!this.isPunctuation(")")) {
      do {
        const argumentCount = args.length + 1;
        if (argumentCount > this.budget.limits.maxFunctionArguments) {
          throw new ArtifactLimitError(
            "formula function arguments",
            argumentCount,
            this.budget.limits.maxFunctionArguments,
          );
        }
        args.push(this.withNesting(() => this.comparison()));
        if (!this.isPunctuation(",")) break;
        this.consume();
      } while (!this.isPunctuation(")"));
    }
    this.expectPunctuation(")");
    const normalizedName = name.toUpperCase();
    if (this.requireSupportedSyntax && !SUPPORTED_FORMULA_FUNCTIONS.has(normalizedName)) {
      throw new FormulaFault("#NAME?");
    }
    try {
      if (this.validateOnly) return null;
      return boundEvaluated(
        callFunction(normalizedName, args, this.budget),
        this.budget.limits.maxResultStringChars,
      );
    } catch (cause) {
      if (cause instanceof FormulaFault) return cause.code;
      throw cause;
    }
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private consume(): Token | undefined {
    const token = this.tokens[this.index++];
    if (token) this.budget.consumeOperations();
    return token;
  }

  private isOperator(
    first: string,
    second?: string,
    third?: string,
    fourth?: string,
    fifth?: string,
    sixth?: string,
  ): boolean {
    const token = this.peek();
    if (token?.type !== "operator") return false;
    const value = token.value;
    return (
      value === first ||
      value === second ||
      value === third ||
      value === fourth ||
      value === fifth ||
      value === sixth
    );
  }

  private isPunctuation(value: FormulaPunctuation): boolean {
    const token = this.peek();
    return token?.type === "punctuation" && token.value === value;
  }

  private expectPunctuation(value: FormulaPunctuation): void {
    const token = this.consume();
    if (token?.type !== "punctuation" || token.value !== value) throw new FormulaFault("#VALUE!");
  }

  private withNesting<T>(callback: () => T): T {
    const nextDepth = this.nestingDepth + 1;
    if (nextDepth > this.budget.limits.maxNestingDepth) {
      throw new ArtifactLimitError(
        "formula nesting depth",
        nextDepth,
        this.budget.limits.maxNestingDepth,
      );
    }
    this.nestingDepth = nextDepth;
    try {
      return callback();
    } finally {
      this.nestingDepth -= 1;
    }
  }
}

function tokenize(input: string, maxTokens: number): Token[] {
  const tokens: Token[] = [];
  const push = (token: Token): void => {
    const tokenCount = tokens.length + 1;
    if (tokenCount > maxTokens) {
      throw new ArtifactLimitError("formula tokens", tokenCount, maxTokens);
    }
    tokens.push(token);
  };
  let index = 0;
  while (index < input.length) {
    const character = input[index]!;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '"') {
      let value = "";
      let terminated = false;
      index += 1;
      while (index < input.length) {
        if (input[index] === '"' && input[index + 1] === '"') {
          value += '"';
          index += 2;
        } else if (input[index] === '"') {
          index += 1;
          terminated = true;
          break;
        } else {
          value += input[index++];
        }
      }
      if (!terminated) throw new FormulaFault("#VALUE!");
      push({ type: "string", value });
      continue;
    }
    if (character === "'") {
      let value = "";
      let terminated = false;
      index += 1;
      while (index < input.length) {
        if (input[index] === "'" && input[index + 1] === "'") {
          value += "'";
          index += 2;
        } else if (input[index] === "'") {
          index += 1;
          terminated = true;
          break;
        } else {
          value += input[index++];
        }
      }
      if (!terminated) throw new FormulaFault("#VALUE!");
      push({ type: "word", value });
      continue;
    }
    const errorMatch = /^#(?:DIV\/0!|N\/A|NAME\?|NUM!|REF!|VALUE!|CYCLE!)/i.exec(
      input.slice(index),
    );
    if (errorMatch) {
      push({
        type: "error",
        value: errorMatch[0]!.toUpperCase() as FormulaErrorValue,
      });
      index += errorMatch[0]!.length;
      continue;
    }
    const numberMatch = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?/.exec(input.slice(index));
    if (numberMatch) {
      push({ type: "number", value: Number(numberMatch[0]) });
      index += numberMatch[0].length;
      continue;
    }
    const cellMatch = /^\$?[A-Za-z]{1,3}\$?[1-9]\d*(?![A-Za-z0-9_.])/.exec(input.slice(index));
    if (cellMatch && input[index + cellMatch[0].length] !== "!") {
      push({ type: "cell", value: cellMatch[0] });
      index += cellMatch[0].length;
      continue;
    }
    const wordMatch = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(input.slice(index));
    if (wordMatch) {
      push({ type: "word", value: wordMatch[0]! });
      index += wordMatch[0]!.length;
      continue;
    }
    const doubleOperator = input.slice(index, index + 2);
    if (["<=", ">=", "<>"].includes(doubleOperator)) {
      push({ type: "operator", value: doubleOperator });
      index += 2;
      continue;
    }
    if (["+", "-", "*", "/", "^", "&", "=", "<", ">", "%"].includes(character)) {
      push({ type: "operator", value: character });
      index += 1;
      continue;
    }
    if (["(", ")", ",", ":", "!"].includes(character)) {
      push({ type: "punctuation", value: character as FormulaPunctuation });
      index += 1;
      continue;
    }
    throw new FormulaFault("#VALUE!");
  }
  return tokens;
}

function scalar(value: Evaluated): Scalar {
  if (Array.isArray(value)) return value[0]?.[0] ?? null;
  return value;
}

function calculate(
  left: Evaluated,
  right: Evaluated,
  operation: (left: Scalar, right: Scalar) => Scalar,
): Scalar {
  const leftValue = scalar(left);
  const rightValue = scalar(right);
  if (isFormulaError(leftValue)) return leftValue;
  if (isFormulaError(rightValue)) return rightValue;
  try {
    return operation(leftValue, rightValue);
  } catch (cause) {
    if (cause instanceof FormulaFault) return cause.code;
    throw cause;
  }
}

function calculateUnary(value: Evaluated, operation: (value: Scalar) => Scalar): Scalar {
  const item = scalar(value);
  if (isFormulaError(item)) return item;
  try {
    return operation(item);
  } catch (cause) {
    if (cause instanceof FormulaFault) return cause.code;
    throw cause;
  }
}

function flatten(values: Evaluated[]): Scalar[] {
  return values.flatMap((value) => (Array.isArray(value) ? value.flat() : [value]));
}

function numeric(value: Evaluated): number {
  const item = scalar(value);
  if (isFormulaError(item)) throw new FormulaFault(item);
  if (item instanceof Date) return item.getTime() / 86_400_000 + 25_569;
  if (item === null || item === false) return 0;
  if (item === true) return 1;
  const number = typeof item === "number" ? item : Number(item);
  if (!Number.isFinite(number)) throw new FormulaFault("#VALUE!");
  return number;
}

function numbers(values: Evaluated[]): number[] {
  const output: number[] = [];
  for (const value of flatten(values)) {
    if (isFormulaError(value)) throw new FormulaFault(value);
    if (value === null || typeof value === "boolean") continue;
    const number = value instanceof Date ? numeric(value) : Number(value);
    if (Number.isFinite(number)) output.push(number);
  }
  return output;
}

function text(value: Scalar, budget: FormulaEvaluationBudget): string {
  if (isFormulaError(value)) throw new FormulaFault(value);
  if (value === null) return "";
  const result = value instanceof Date ? value.toISOString() : String(value);
  return boundedText(result, budget.limits.maxResultStringChars);
}

function truthy(value: Evaluated): boolean {
  const item = scalar(value);
  if (isFormulaError(item)) throw new FormulaFault(item);
  return Boolean(item);
}

function compare(a: Scalar, b: Scalar, operator: string): boolean {
  if (isFormulaError(a)) throw new FormulaFault(a);
  if (isFormulaError(b)) throw new FormulaFault(b);
  const left = a instanceof Date ? a.getTime() : typeof a === "string" ? a.toLowerCase() : a;
  const right = b instanceof Date ? b.getTime() : typeof b === "string" ? b.toLowerCase() : b;
  switch (operator) {
    case "=":
      return left === right;
    case "<>":
      return left !== right;
    case "<":
      return (left as number) < (right as number);
    case ">":
      return (left as number) > (right as number);
    case "<=":
      return (left as number) <= (right as number);
    case ">=":
      return (left as number) >= (right as number);
    default:
      return false;
  }
}

function callFunction(name: string, args: Evaluated[], budget: FormulaEvaluationBudget): Evaluated {
  const numericArgs = () => numbers(args);
  switch (name) {
    case "SUM":
      return numericArgs().reduce((sum, value) => sum + value, 0);
    case "AVERAGE": {
      const values = numericArgs();
      if (values.length === 0) throw new FormulaFault("#DIV/0!");
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    }
    case "MIN": {
      const values = numericArgs();
      if (values.length === 0) return 0;
      let minimum = values[0]!;
      for (let index = 1; index < values.length; index += 1)
        minimum = Math.min(minimum, values[index]!);
      return minimum;
    }
    case "MAX": {
      const values = numericArgs();
      if (values.length === 0) return 0;
      let maximum = values[0]!;
      for (let index = 1; index < values.length; index += 1)
        maximum = Math.max(maximum, values[index]!);
      return maximum;
    }
    case "COUNT":
      return numericArgs().length;
    case "COUNTA":
      return flatten(args).filter((value) => value !== null && value !== "").length;
    case "IF":
      return truthy(args[0] ?? false) ? (args[1] ?? true) : (args[2] ?? false);
    case "IFERROR": {
      const value = scalar(args[0] ?? null);
      return isFormulaError(value) ? (args[1] ?? null) : value;
    }
    case "AND": {
      const values = args.map(truthy);
      return values.every(Boolean);
    }
    case "OR": {
      const values = args.map(truthy);
      return values.some(Boolean);
    }
    case "NOT":
      return !truthy(args[0] ?? false);
    case "ABS":
      return Math.abs(numeric(args[0] ?? 0));
    case "ROUND": {
      const digits = numeric(args[1] ?? 0);
      const factor = 10 ** digits;
      const value = numeric(args[0] ?? 0) * factor;
      return (Math.sign(value) * Math.round(Math.abs(value))) / factor;
    }
    case "ROUNDUP": {
      const digits = numeric(args[1] ?? 0);
      const factor = 10 ** digits;
      const value = numeric(args[0] ?? 0) * factor;
      return (Math.sign(value) * Math.ceil(Math.abs(value))) / factor;
    }
    case "ROUNDDOWN": {
      const digits = numeric(args[1] ?? 0);
      const factor = 10 ** digits;
      const value = numeric(args[0] ?? 0) * factor;
      return (Math.sign(value) * Math.floor(Math.abs(value))) / factor;
    }
    case "POWER":
      return finiteNumber(Math.pow(numeric(args[0] ?? 0), numeric(args[1] ?? 0)));
    case "SQRT": {
      const value = numeric(args[0] ?? 0);
      if (value < 0) throw new FormulaFault("#NUM!");
      return Math.sqrt(value);
    }
    case "LEN":
      return text(scalar(args[0] ?? null), budget).length;
    case "LOWER":
      return text(scalar(args[0] ?? null), budget).toLowerCase();
    case "UPPER":
      return text(scalar(args[0] ?? null), budget).toUpperCase();
    case "TRIM":
      return text(scalar(args[0] ?? null), budget)
        .trim()
        .replace(/\s+/g, " ");
    case "LEFT":
      return text(scalar(args[0] ?? null), budget).slice(0, numeric(args[1] ?? 1));
    case "RIGHT":
      return text(scalar(args[0] ?? null), budget).slice(-numeric(args[1] ?? 1));
    case "MID":
      return text(scalar(args[0] ?? null), budget).slice(
        numeric(args[1] ?? 1) - 1,
        numeric(args[1] ?? 1) - 1 + numeric(args[2] ?? 0),
      );
    case "CONCAT":
      return concatenateText(
        flatten(args).map((value) => text(value, budget)),
        budget,
      );
    case "DATE":
      return new Date(
        Date.UTC(numeric(args[0] ?? 1900), numeric(args[1] ?? 1) - 1, numeric(args[2] ?? 1)),
      );
    case "YEAR":
      return dateValue(args[0]).getUTCFullYear();
    case "MONTH":
      return dateValue(args[0]).getUTCMonth() + 1;
    case "DAY":
      return dateValue(args[0]).getUTCDate();
    case "INDEX": {
      const matrix = Array.isArray(args[0]) ? args[0] : [[scalar(args[0] ?? null)]];
      const row = numeric(args[1] ?? 1) - 1;
      const col = numeric(args[2] ?? 1) - 1;
      return matrix[row]?.[col] ?? "#REF!";
    }
    case "MATCH": {
      const wanted = scalar(args[0] ?? null);
      const haystack = flatten([args[1] ?? []]);
      const index = haystack.findIndex((item) => compare(item, wanted, "="));
      return index < 0 ? "#N/A" : index + 1;
    }
    case "XLOOKUP": {
      const wanted = scalar(args[0] ?? null);
      const keys = flatten([args[1] ?? []]);
      const values = flatten([args[2] ?? []]);
      const index = keys.findIndex((item) => compare(item, wanted, "="));
      return index < 0 ? scalar(args[3] ?? "#N/A") : (values[index] ?? "#N/A");
    }
    default:
      throw new FormulaFault("#NAME?");
  }
}

function dateValue(value: Evaluated | undefined): Date {
  const item = scalar(value ?? null);
  if (isFormulaError(item)) throw new FormulaFault(item);
  if (item instanceof Date) return item;
  if (typeof item === "number") return new Date((item - 25_569) * 86_400_000);
  const date = new Date(String(item));
  if (Number.isNaN(date.getTime())) throw new FormulaFault("#VALUE!");
  return date;
}

function finiteNumber(value: number): number {
  if (!Number.isFinite(value)) throw new FormulaFault("#NUM!");
  return value;
}

function boundedText(value: string, maximum: number): string {
  if (value.length > maximum) {
    throw new ArtifactLimitError("formula result characters", value.length, maximum);
  }
  return value;
}

function boundedScalar(value: Scalar, maximum: number): Scalar {
  if (typeof value === "string") return boundedText(value, maximum);
  if (typeof value === "number" && !Number.isFinite(value)) throw new FormulaFault("#NUM!");
  return value;
}

function boundEvaluated(value: Evaluated, maximum: number): Evaluated {
  if (!Array.isArray(value)) return boundedScalar(value, maximum);
  for (const row of value) {
    for (const cell of row) boundedScalar(cell, maximum);
  }
  return value;
}

function concatenateText(parts: readonly string[], budget: FormulaEvaluationBudget): string {
  let characters = 0;
  for (const part of parts) {
    characters = checkedFuelTotal(characters, part.length);
    if (characters > budget.limits.maxResultStringChars) {
      throw new ArtifactLimitError(
        "formula result characters",
        characters,
        budget.limits.maxResultStringChars,
      );
    }
  }
  return parts.join("");
}

function checkedFuelTotal(current: number, count: number): number {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new ArtifactLimitError("formula fuel increment", count, Number.MAX_SAFE_INTEGER);
  }
  const next = current + count;
  if (!Number.isSafeInteger(next)) {
    throw new ArtifactLimitError("formula fuel", Number.MAX_SAFE_INTEGER, current);
  }
  return next;
}

function assertFormulaByteLimit(formula: string, maximum: number): void {
  // UTF-16 length is a lower bound on UTF-8 bytes. This O(1) gate rejects giant ASCII inputs
  // without scanning them; the bounded path below computes the exact byte count without allocation.
  if (formula.length > maximum) {
    throw new ArtifactLimitError("formula bytes", formula.length, maximum);
  }
  let bytes = 0;
  for (let index = 0; index < formula.length; index += 1) {
    const codePoint = formula.codePointAt(index)!;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else {
      bytes += 4;
      index += 1;
    }
    if (bytes > maximum) {
      throw new ArtifactLimitError("formula bytes", bytes, maximum);
    }
  }
}

function isFormulaError(value: Scalar): value is FormulaErrorValue {
  return typeof value === "string" && FORMULA_ERRORS.has(value as FormulaErrorValue);
}

const FORMULA_ERRORS = new Set<FormulaErrorValue>([
  "#DIV/0!",
  "#N/A",
  "#NAME?",
  "#NUM!",
  "#REF!",
  "#VALUE!",
  "#CYCLE!",
]);

function forEachFormulaCode(formula: string, callback: (code: string) => void): void {
  mapFormulaCode(formula, (code) => {
    callback(code);
    return code;
  });
}

function mapFormulaCode(formula: string, transform: (code: string) => string): string {
  let result = "";
  let codeStart = 0;
  let index = 0;
  while (index < formula.length) {
    // A quoted worksheet qualifier is formula code, not a string literal. Skip over the complete
    // identifier while looking for double-quoted literals so a legal `"` in its name cannot split
    // the qualifier and hide or corrupt the following cell reference.
    if (formula[index] === "'") {
      index += 1;
      while (index < formula.length) {
        if (formula[index] !== "'") {
          index += 1;
          continue;
        }
        if (formula[index + 1] === "'") {
          index += 2;
          continue;
        }
        index += 1;
        break;
      }
      continue;
    }
    if (formula[index] !== '"') {
      index += 1;
      continue;
    }

    result += transform(formula.slice(codeStart, index));
    const stringStart = index;
    index += 1;
    while (index < formula.length) {
      if (formula[index] !== '"') {
        index += 1;
        continue;
      }
      if (formula[index + 1] === '"') {
        index += 2;
        continue;
      }
      index += 1;
      break;
    }
    result += formula.slice(stringStart, index);
    codeStart = index;
  }
  result += transform(formula.slice(codeStart));
  return result;
}
