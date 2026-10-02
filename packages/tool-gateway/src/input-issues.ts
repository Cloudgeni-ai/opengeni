import type { ErrorObject } from "ajv";

/**
 * One argument problem found by input-schema validation. Every field is derived
 * from the property path and the tool's schema, never from an argument value,
 * so the summary is safe to show to the model and to return over HTTP.
 */
export type ToolGatewayInputIssue = {
  /** Readable path of the offending property (`context`, `filters[0].field`); empty for the arguments object itself. */
  readonly path: string;
  /** JSON Schema keyword that failed, such as `required`, `type`, or `additionalProperties`. */
  readonly keyword: string;
  /** Short, value-free sentence fragment naming the property and what the schema expects. */
  readonly message: string;
};

export type ToolGatewayInputIssueSummary = {
  readonly issues: readonly ToolGatewayInputIssue[];
  /** Distinct problems found beyond the reported cap. */
  readonly omittedIssueCount: number;
};

/** Maximum problems named in one validation error. */
export const TOOL_GATEWAY_INPUT_ISSUES_MAX = 8;

const PATH_MAX_CHARS = 120;
const MESSAGE_DETAIL_MAX_CHARS = 160;
const ALLOWED_VALUES_MAX = 10;
const ALLOWED_VALUE_MAX_CHARS = 60;

/**
 * Convert validator errors into a capped, de-duplicated list of value-free issues.
 * Validator messages only quote schema facts (types, limits, patterns), and
 * values offered here come from `enum`/`const` in the schema, not the arguments.
 */
export function summarizeToolGatewayInputErrors(
  errors: readonly ErrorObject[] | null | undefined,
): ToolGatewayInputIssueSummary {
  const issues: ToolGatewayInputIssue[] = [];
  const seen = new Set<string>();
  let omittedIssueCount = 0;
  for (const error of errors ?? []) {
    const issue = issueFromError(error);
    if (seen.has(issue.message)) continue;
    seen.add(issue.message);
    if (issues.length < TOOL_GATEWAY_INPUT_ISSUES_MAX) issues.push(issue);
    else omittedIssueCount += 1;
  }
  return { issues, omittedIssueCount };
}

/** One-line summary of issues, for example `missing required property "context"`. */
export function formatToolGatewayInputIssues(
  issues: readonly ToolGatewayInputIssue[],
  omittedIssueCount = 0,
): string {
  const parts = issues.map((issue) => issue.message);
  if (omittedIssueCount > 0) {
    parts.push(`and ${omittedIssueCount} more ${omittedIssueCount === 1 ? "problem" : "problems"}`);
  }
  return parts.join("; ");
}

function issueFromError(error: ErrorObject): ToolGatewayInputIssue {
  const params = (error.params ?? {}) as Record<string, unknown>;
  const at = pointerSegments(error.instancePath);
  const subject = describe(displayPath(at));
  // A `propertyNames` subschema failure describes a key of the object at
  // `instancePath`, not the object itself; name the object, never the key.
  const keyword =
    (error as { propertyName?: unknown }).propertyName !== undefined
      ? "propertyNames"
      : error.keyword;
  switch (keyword) {
    case "required": {
      const path = displayPath([...at, String(params.missingProperty)]);
      return { path, keyword: error.keyword, message: `missing required property "${path}"` };
    }
    case "dependentRequired":
    case "dependencies": {
      const path = displayPath([...at, String(params.missingProperty)]);
      const trigger = displayPath([...at, String(params.property)]);
      return {
        path,
        keyword: error.keyword,
        message: `missing required property "${path}" (required when "${trigger}" is present)`,
      };
    }
    case "additionalProperties":
    case "unevaluatedProperties": {
      const name = params.additionalProperty ?? params.unevaluatedProperty;
      const path = displayPath([...at, String(name)]);
      return { path, keyword: error.keyword, message: `property "${path}" is not allowed` };
    }
    case "type": {
      const expected = Array.isArray(params.type) ? params.type.join(" or ") : String(params.type);
      return {
        path: displayPath(at),
        keyword: error.keyword,
        message: `${subject} must be ${bounded(expected, MESSAGE_DETAIL_MAX_CHARS)}`,
      };
    }
    case "enum": {
      const allowed = Array.isArray(params.allowedValues)
        ? allowedValuesText(params.allowedValues)
        : null;
      return {
        path: displayPath(at),
        keyword: error.keyword,
        message: allowed
          ? `${subject} must be one of ${allowed}`
          : `${subject} must be one of the allowed values`,
      };
    }
    case "const":
      return {
        path: displayPath(at),
        keyword: error.keyword,
        message: `${subject} must equal ${schemaValueText(params.allowedValue)}`,
      };
    case "propertyNames":
      return {
        path: displayPath(at),
        keyword,
        message: `${subject} has a property name the schema does not allow`,
      };
    default:
      return {
        path: displayPath(at),
        keyword: bounded(error.keyword, 64),
        message: `${subject} ${bounded(cleanText(error.message ?? "is invalid"), MESSAGE_DETAIL_MAX_CHARS)}`,
      };
  }
}

function describe(path: string): string {
  return path ? `"${path}"` : "arguments";
}

function pointerSegments(pointer: string): string[] {
  if (!pointer) return [];
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/gu, "/").replace(/~0/gu, "~"));
}

/**
 * Render JSON Pointer segments as `a.b[0].c`. A top-level name is shown as is;
 * an unusual nested name is bracket-quoted so the path stays unambiguous.
 */
function displayPath(segments: readonly string[]): string {
  let path = "";
  for (const segment of segments) {
    if (/^(?:0|[1-9][0-9]*)$/u.test(segment)) path += `[${segment}]`;
    else if (!path) path = cleanText(segment);
    else if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/u.test(segment)) path += `.${segment}`;
    else path += `[${JSON.stringify(segment)}]`;
    if (path.length > PATH_MAX_CHARS) break;
  }
  return bounded(path, PATH_MAX_CHARS);
}

function allowedValuesText(values: readonly unknown[]): string | null {
  if (values.length === 0) return null;
  const shown = values.slice(0, ALLOWED_VALUES_MAX).map(schemaValueText);
  if (values.length > ALLOWED_VALUES_MAX) shown.push("...");
  return shown.join(", ");
}

function schemaValueText(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = "the schema constant";
  }
  return bounded(cleanText(text), ALLOWED_VALUE_MAX_CHARS);
}

function cleanText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}
