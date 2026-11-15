/**
 * Measure serialized JSON object text in one linear pass, without decoding it.
 *
 * Approval RunState bounds are checked on text that is already in memory
 * (before a save) or already limited to its byte bound (after a read). This
 * scanner validates that text against the JSON grammar PostgreSQL's `jsonb`
 * input accepts and counts what `jsonb_path_query(value, 'strict $.**')`
 * would return, without building any objects. It replaces measuring the same
 * text inside PostgreSQL: `jsonb_path_query` materializes every result and
 * hands each one out with `list_delete_first`, which moves the rest of the
 * list, so counting n nodes there costs O(n^2) memory traffic regardless of
 * any LIMIT. A 200,000-element array took seconds of server CPU, and much
 * longer on hosts with slower memory.
 *
 * - `nodes` counts every JSON value, including the root, like `strict $.**`.
 * - `properties` counts every object member.
 * - Duplicate keys are counted each time they appear. `jsonb` keeps only the
 *   last one, so these counts are never lower than what the database would
 *   measure on the stored value; `JSON.stringify` never emits duplicates.
 * - `\u0000` and unpaired UTF-16 surrogate escapes are invalid here because
 *   `jsonb` cannot store them; text containing them could be saved but never
 *   decoded by the database again.
 *
 * Counts are zero unless the text is one valid JSON object.
 */
export type JsonObjectTextMeasurement = {
  validJsonObject: boolean;
  nodes: number;
  properties: number;
};

const INVALID: JsonObjectTextMeasurement = {
  validJsonObject: false,
  nodes: 0,
  properties: 0,
};

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;
const MINUS = 0x2d;
const PLUS = 0x2b;
const DOT = 0x2e;
const ZERO = 0x30;
const NINE = 0x39;

const IN_ARRAY = 0;
const IN_OBJECT = 1;

export function measureJsonObjectText(text: string): JsonObjectTextMeasurement {
  const length = text.length;
  let index = skipWhitespace(text, 0);
  if (text.charCodeAt(index) !== OPEN_OBJECT) return INVALID;

  let nodes = 0;
  let properties = 0;
  const containers: number[] = [];
  // Each iteration starts at a value, or at the first key of an object.
  let expectKey = false;
  for (;;) {
    if (expectKey) {
      if (text.charCodeAt(index) !== QUOTE) return INVALID;
      index = scanString(text, index);
      if (index < 0) return INVALID;
      properties += 1;
      index = skipWhitespace(text, index);
      if (text.charCodeAt(index) !== COLON) return INVALID;
      index = skipWhitespace(text, index + 1);
      expectKey = false;
    }

    const code = text.charCodeAt(index);
    nodes += 1;
    if (code === OPEN_OBJECT || code === OPEN_ARRAY) {
      index = skipWhitespace(text, index + 1);
      const close = code === OPEN_OBJECT ? CLOSE_OBJECT : CLOSE_ARRAY;
      if (text.charCodeAt(index) !== close) {
        containers.push(code === OPEN_OBJECT ? IN_OBJECT : IN_ARRAY);
        expectKey = code === OPEN_OBJECT;
        continue;
      }
      index += 1;
    } else if (code === QUOTE) {
      index = scanString(text, index);
    } else if (code === MINUS || (code >= ZERO && code <= NINE)) {
      index = scanNumber(text, index);
    } else if (text.startsWith("true", index) || text.startsWith("null", index)) {
      index += 4;
    } else if (text.startsWith("false", index)) {
      index += 5;
    } else {
      return INVALID;
    }
    if (index < 0) return INVALID;

    // After a complete value: close finished containers, or move to the next
    // member or element.
    for (;;) {
      index = skipWhitespace(text, index);
      const container = containers.at(-1);
      if (container === undefined) {
        return index === length ? { validJsonObject: true, nodes, properties } : INVALID;
      }
      const next = text.charCodeAt(index);
      if (next === COMMA) {
        index = skipWhitespace(text, index + 1);
        expectKey = container === IN_OBJECT;
        break;
      }
      if (next !== (container === IN_OBJECT ? CLOSE_OBJECT : CLOSE_ARRAY)) return INVALID;
      containers.pop();
      index += 1;
    }
  }
}

function skipWhitespace(text: string, start: number): number {
  let index = start;
  for (;;) {
    const code = text.charCodeAt(index);
    // JSON whitespace: space, tab, line feed, carriage return.
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return index;
    index += 1;
  }
}

/** Index after the closing quote of the string starting at `start`, or -1. */
function scanString(text: string, start: number): number {
  const length = text.length;
  let index = start + 1;
  while (index < length) {
    const code = text.charCodeAt(index);
    if (code === QUOTE) return index + 1;
    if (code < 0x20) return -1;
    if (code !== BACKSLASH) {
      index += 1;
      continue;
    }
    const escape = text.charCodeAt(index + 1);
    if (
      escape === QUOTE ||
      escape === BACKSLASH ||
      escape === 0x2f || // /
      escape === 0x62 || // b
      escape === 0x66 || // f
      escape === 0x6e || // n
      escape === 0x72 || // r
      escape === 0x74 // t
    ) {
      index += 2;
      continue;
    }
    if (escape !== 0x75) return -1; // u
    const unit = hexUnit(text, index + 2);
    index += 6;
    if (unit <= 0) return -1; // malformed, or U+0000 (jsonb cannot store it)
    if (unit >= 0xdc00 && unit <= 0xdfff) return -1; // low surrogate first
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (text.charCodeAt(index) !== BACKSLASH || text.charCodeAt(index + 1) !== 0x75) return -1;
      const low = hexUnit(text, index + 2);
      if (low < 0xdc00 || low > 0xdfff) return -1;
      index += 6;
    }
  }
  return -1;
}

/** The four hex digits at `start` as a UTF-16 code unit, or -1. */
function hexUnit(text: string, start: number): number {
  let unit = 0;
  for (let index = start; index < start + 4; index += 1) {
    const code = text.charCodeAt(index);
    let digit: number;
    if (code >= ZERO && code <= NINE) digit = code - ZERO;
    else if (code >= 0x61 && code <= 0x66)
      digit = code - 0x57; // a-f
    else if (code >= 0x41 && code <= 0x46)
      digit = code - 0x37; // A-F
    else return -1;
    unit = unit * 16 + digit;
  }
  return unit;
}

/** Index after the JSON number starting at `start`, or -1. */
function scanNumber(text: string, start: number): number {
  let index = start;
  if (text.charCodeAt(index) === MINUS) index += 1;
  if (text.charCodeAt(index) === ZERO) {
    index += 1;
  } else {
    if (!isDigit(text.charCodeAt(index))) return -1;
    index = skipDigits(text, index);
  }
  if (text.charCodeAt(index) === DOT) {
    if (!isDigit(text.charCodeAt(index + 1))) return -1;
    index = skipDigits(text, index + 1);
  }
  const exponent = text.charCodeAt(index);
  if (exponent === 0x65 || exponent === 0x45) {
    index += 1;
    const sign = text.charCodeAt(index);
    if (sign === PLUS || sign === MINUS) index += 1;
    if (!isDigit(text.charCodeAt(index))) return -1;
    index = skipDigits(text, index);
  }
  return index;
}

function isDigit(code: number): boolean {
  return code >= ZERO && code <= NINE;
}

function skipDigits(text: string, start: number): number {
  let index = start;
  while (isDigit(text.charCodeAt(index))) index += 1;
  return index;
}
