import type { GenericPathOperation } from "./integration-definitions";
import type { IntegrationToolDefinition } from "./types";
import { IntegrationInvocationError } from "./types";

/**
 * Generic access to the rest of a reviewed API: one tool finds operations in
 * the reviewed document's opted-in path scope, and a read tool (GET) and a
 * change tool (other methods) call one of them by its concrete path. A path
 * is only sent when it matches an operation in that scope, segment by
 * segment, so the calls can't leave the scope the definition reviewed.
 */
export type GenericPathRole = "find" | "read" | "change";

export interface GenericPathBinding {
  readonly role: GenericPathRole;
  /** The operations in scope; carried by the find binding only. */
  readonly operations?: readonly GenericPathOperation[];
}

export const GENERIC_PATH_OPERATION_KEYS: Readonly<Record<GenericPathRole, string>> = {
  find: "find_operations",
  read: "call_read_operation",
  change: "call_change_operation",
};

const CHANGE_METHODS = ["post", "put", "patch", "delete"] as const;
const FIND_LIMIT = 10;
const FIND_MAX_LIMIT = 25;
const MAX_PATH_CHARS = 2_048;
const BLOCKED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
]);

const queryProperty = {
  type: "object",
  description:
    "Query parameters, for example $select, $filter, $top or $search. Values are strings, numbers, booleans or arrays of them.",
  additionalProperties: true,
};
const headerProperty = {
  type: "object",
  description: "Extra request headers the operation documents, for example Prefer.",
  additionalProperties: { type: "string" },
};
const pathProperty = {
  type: "string",
  minLength: 1,
  maxLength: MAX_PATH_CHARS,
  description:
    "The concrete path under the API's base URL: the operation's path template with each {placeholder} replaced by its value, without a query string.",
};

/** The three generic tools, with their reviewed text and approval defaults. */
export function genericPathTools(
  ids: Readonly<Record<GenericPathRole, string>>,
): IntegrationToolDefinition[] {
  const find: IntegrationToolDefinition = {
    id: ids.find,
    operationKey: GENERIC_PATH_OPERATION_KEYS.find,
    name: "Find API operations",
    description:
      "Find operations of this API that the other tools of this integration don't cover. Searches the reviewed API description by words in the path or summary and returns each match's method, path template and summary, the scopes it needs when the API declares them, and the dedicated tool when one exists. Call a match with this integration's call tools: the read one for GET, the change one for other methods. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Words to look for in the operation's path and summary.",
        },
        method: { type: "string", enum: ["get", ...CHANGE_METHODS] },
        limit: { type: "integer", minimum: 1, maximum: FIND_MAX_LIMIT },
      },
      required: ["query"],
      additionalProperties: false,
    },
    safety: "read",
    approvalMode: "never",
    deprecated: false,
  };
  const read: IntegrationToolDefinition = {
    id: ids.read,
    operationKey: GENERIC_PATH_OPERATION_KEYS.read,
    name: "Call API read operation",
    description:
      "Call a GET operation of this API that no other tool of this integration covers, using its concrete path. Find the operation first with this integration's find tool. Read-only.",
    inputSchema: {
      type: "object",
      properties: { path: pathProperty, query: queryProperty, header: headerProperty },
      required: ["path"],
      additionalProperties: false,
    },
    safety: "read",
    approvalMode: "never",
    deprecated: false,
  };
  const change: IntegrationToolDefinition = {
    id: ids.change,
    operationKey: GENERIC_PATH_OPERATION_KEYS.change,
    name: "Call API change operation",
    description:
      "Call a POST, PUT, PATCH or DELETE operation of this API that no other tool of this integration covers, using its concrete path. Find the operation first with this integration's find tool. Changes external state. Your tool permissions determine whether review is needed.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: [...CHANGE_METHODS] },
        path: pathProperty,
        query: queryProperty,
        header: headerProperty,
        body: {
          description:
            "The request body: JSON for JSON operations, or text with contentType for others.",
        },
        contentType: {
          type: "string",
          maxLength: 128,
          description: "The body's media type when it isn't JSON, for example text/plain.",
        },
      },
      required: ["method", "path"],
      additionalProperties: false,
    },
    safety: "destructive",
    approvalMode: "ask",
    deprecated: false,
  };
  return [find, read, change];
}

/** Words of a path or summary, splitting camelCase and punctuation. */
function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Operations matching the find tool's words, best first. */
export function findGenericPathOperations(
  operations: readonly GenericPathOperation[],
  args: Record<string, unknown>,
  reviewedTools: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const query = typeof args.query === "string" ? args.query : "";
  const terms = [...new Set(words(query))];
  if (terms.length === 0) {
    throw new IntegrationInvocationError(
      "parameter_invalid",
      "query needs at least one word to look for",
      "not_started",
      false,
    );
  }
  const method = typeof args.method === "string" ? args.method.toLowerCase() : undefined;
  const limit =
    typeof args.limit === "number" && Number.isInteger(args.limit)
      ? Math.min(Math.max(args.limit, 1), FIND_MAX_LIMIT)
      : FIND_LIMIT;
  const scored = operations
    .filter((operation) => !method || operation.method === method)
    .map((operation) => {
      const haystack = new Set([
        ...words(operation.path),
        ...words(operation.summary ?? ""),
        operation.method,
      ]);
      const text = `${operation.path} ${operation.summary ?? ""}`.toLowerCase();
      const score = terms.reduce(
        (total, term) => total + (haystack.has(term) ? 2 : text.includes(term) ? 1 : 0),
        0,
      );
      return { operation, score };
    })
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.operation.path.length - right.operation.path.length ||
        (left.operation.path < right.operation.path ? -1 : 1),
    );
  return {
    total: scored.length,
    operations: scored.slice(0, limit).map(({ operation }) => {
      const tool = reviewedTools.get(`${operation.method} ${operation.path}`);
      return {
        method: operation.method.toUpperCase(),
        path: operation.path,
        ...(operation.summary ? { summary: operation.summary } : {}),
        ...(operation.scopes ? { scopes: operation.scopes } : {}),
        ...(tool ? { tool } : {}),
      };
    }),
  };
}

function invalid(message: string): IntegrationInvocationError {
  return new IntegrationInvocationError("parameter_invalid", message, "not_started", false);
}

function decodedOnce(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A value placed in a path segment: encoded, never `.` or `..`. */
function encodedValue(value: string): string {
  if (value === "." || value === "..") throw invalid("A path segment cannot be . or ..");
  try {
    return encodeURIComponent(value).replaceAll("'", "%27");
  } catch {
    throw invalid("The path is not valid Unicode text");
  }
}

/**
 * The encoded path of the in-scope operation a concrete path names, or a
 * parameter error. Each `{placeholder}` takes one non-empty segment value
 * (or part of one); literal text must match the template.
 */
export function resolveGenericPath(
  operations: readonly GenericPathOperation[],
  method: string,
  rawPath: unknown,
): { path: string; operation: GenericPathOperation } {
  if (typeof rawPath !== "string" || !rawPath.startsWith("/") || rawPath.length > MAX_PATH_CHARS) {
    throw invalid("path must start with / and name an operation's concrete path");
  }
  if (/[?#]/.test(rawPath)) {
    throw invalid("Put query parameters in query, not in path");
  }
  const segments = rawPath.slice(1).replace(/\/$/, "").split("/");
  if (segments.some((segment) => segment === "")) {
    throw invalid("path cannot contain empty segments");
  }
  let best: { path: string; operation: GenericPathOperation; literal: number } | undefined;
  for (const operation of operations) {
    if (operation.method !== method) continue;
    const template = operation.path.slice(1).split("/");
    if (template.length !== segments.length) continue;
    const encoded: string[] = [];
    let literal = 0;
    let matched = true;
    for (const [index, part] of template.entries()) {
      const value = decodedOnce(segments[index]!);
      const names = [...part.matchAll(/\{([^}]+)\}/g)];
      if (names.length === 0) {
        if (value.toLowerCase() !== part.toLowerCase()) {
          matched = false;
          break;
        }
        literal += 1;
        encoded.push(part);
        continue;
      }
      const pieces = part.split(/\{[^}]+\}/);
      const pattern = new RegExp(`^${pieces.map(escapeRegExp).join("(.+?)")}$`, "i");
      const values = pattern.exec(value);
      if (!values) {
        matched = false;
        break;
      }
      encoded.push(
        pieces
          .map((piece, position) =>
            position === 0 ? piece : `${encodedValue(values[position]!)}${piece}`,
          )
          .join(""),
      );
    }
    if (matched && (!best || literal > best.literal)) {
      best = { path: `/${encoded.join("/")}`, operation, literal };
    }
  }
  if (!best) {
    throw invalid(
      `No ${method.toUpperCase()} operation in this integration's scope matches that path. Find the operation and its path template with this integration's find tool.`,
    );
  }
  return best;
}

/** Headers a generic call may send; credentials stay with the integration. */
export function genericPathHeaders(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw invalid("header must be an object");
  const headers: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (BLOCKED_HEADERS.has(name.toLowerCase())) {
      throw invalid(`The header ${name} can't be set here`);
    }
    if (typeof entry !== "string") throw invalid("Header values must be strings");
    headers[name] = entry;
  }
  return headers;
}

export function genericPathChangeMethod(value: unknown): (typeof CHANGE_METHODS)[number] {
  const method = typeof value === "string" ? value.toLowerCase() : "";
  const allowed = CHANGE_METHODS.find((entry) => entry === method);
  if (!allowed) throw invalid("method must be post, put, patch or delete");
  return allowed;
}
