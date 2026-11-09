/**
 * Account-scoped parameter defaults for connected MCP servers.
 *
 * Some servers require an identifier on most tools that the connected account
 * already fixes: the Atlassian site (cloudId), a Sentry organization, an Asana
 * workspace. Without help every model must first find the lookup tool and copy
 * the value, and models do guess instead (passing description prose as the
 * id). Opengeni fills such a parameter from the account itself.
 *
 * The mechanism is generic; each server contributes only declarative data
 * keyed by its exact MCP URL (like the account identity verifiers): the
 * parameter's name and a read-only tool on the same server that lists the
 * account's values. Nothing here adds prompt or tool-instruction text for a
 * specific connector; the schema note is the same for every server.
 *
 * Lenient by design: a failed or empty lookup passes the call through
 * unchanged, so the provider's own error still reaches the model.
 */

/** One parameter the connected account fixes. Declarative per-connector data. */
export type McpAccountParameter = Readonly<{
  /** Input property filled from the account. */
  name: string;
  /** Read-only tool on the same server that lists the account's values. */
  resolver: Readonly<{ toolName: string; arguments: Readonly<Record<string, unknown>> }>;
  /** Field of each listed item that holds the value to fill in. */
  valueField: string;
  /** Fields that name an item for the model, in order of preference. */
  labelFields: readonly string[];
}>;

/** One value the account offers for a parameter. */
export type McpAccountChoice = Readonly<{ value: string; label?: string }>;

/**
 * Atlassian's MCP tools take the site as cloudId; getAccessibleAtlassianResources
 * lists the sites the token can reach as `{ id, name, url, ... }`.
 * https://support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools/
 */
const ATLASSIAN_SITE: McpAccountParameter = {
  name: "cloudId",
  resolver: { toolName: "getAccessibleAtlassianResources", arguments: {} },
  valueField: "id",
  labelFields: ["name", "url"],
};

/** Keyed by exact MCP URL, as the connection stores it. */
const MCP_ACCOUNT_PARAMETERS: ReadonlyMap<string, readonly McpAccountParameter[]> = new Map([
  ["https://mcp.atlassian.com/v2/mcp?tools=all", [ATLASSIAN_SITE]],
  ["https://mcp.atlassian.com/v2/mcp", [ATLASSIAN_SITE]],
  ["https://mcp.atlassian.com/v1/mcp/authv2", [ATLASSIAN_SITE]],
  ["https://mcp.atlassian.com/v1/mcp", [ATLASSIAN_SITE]],
]);

/** The account parameters declared for an exact MCP URL (none for most servers). */
export function mcpAccountParametersFor(url: string | undefined): readonly McpAccountParameter[] {
  return (url && MCP_ACCOUNT_PARAMETERS.get(url)) || [];
}

/** Appended to a filled parameter's description. The same for every server. */
export const MCP_ACCOUNT_PARAMETER_NOTE = "Optional; defaults to the connected account's value.";

const MAX_ACCOUNT_CHOICES = 200;
const MAX_CHOICE_TEXT = 256;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function acceptsString(property: Record<string, unknown>): boolean {
  const type = property.type;
  return (
    type === undefined || type === "string" || (Array.isArray(type) && type.includes("string"))
  );
}

/**
 * A tool's schema with each required account parameter made optional and
 * noted, and the parameters this tool may have filled. A parameter the tool
 * already treats as optional keeps its meaning: omitting it may mean "all".
 */
export function withAccountParameterDefaults(
  inputSchema: unknown,
  parameters: readonly McpAccountParameter[],
): { inputSchema: unknown; filled: readonly McpAccountParameter[] } {
  if (parameters.length === 0 || !isRecord(inputSchema) || !isRecord(inputSchema.properties))
    return { inputSchema, filled: [] };
  const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];
  const filled = parameters.filter((parameter) => {
    const property = (inputSchema.properties as Record<string, unknown>)[parameter.name];
    return required.includes(parameter.name) && isRecord(property) && acceptsString(property);
  });
  if (filled.length === 0) return { inputSchema, filled };
  const names = new Set(filled.map((parameter) => parameter.name));
  const properties = { ...inputSchema.properties };
  for (const name of names) {
    const property = properties[name] as Record<string, unknown>;
    const description = typeof property.description === "string" ? property.description.trim() : "";
    properties[name] = {
      ...property,
      description: description
        ? `${description} ${MCP_ACCOUNT_PARAMETER_NOTE}`
        : MCP_ACCOUNT_PARAMETER_NOTE,
    };
  }
  return {
    inputSchema: {
      ...inputSchema,
      properties,
      required: required.filter((name) => !(typeof name === "string" && names.has(name))),
    },
    filled,
  };
}

/** A tool result's payloads: structured content, then each JSON text block. */
function resultPayloads(result: unknown): unknown[] {
  if (!isRecord(result)) return [];
  const payloads: unknown[] = [];
  if (result.structuredContent !== undefined) payloads.push(result.structuredContent);
  for (const block of Array.isArray(result.content) ? result.content : []) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
    try {
      payloads.push(JSON.parse(block.text));
    } catch {
      // Not JSON; another block may be.
    }
  }
  return payloads;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, MAX_CHOICE_TEXT)
    : undefined;
}

const carriesValues = (items: unknown[], valueField: string): boolean =>
  items.some((item) => isRecord(item) && text(item[valueField]) !== undefined);

/**
 * Items of the shallowest list that carries values: the payload itself, else a
 * list directly inside it, else one a level deeper. Shallow lists win so a
 * nested list (a user's own accounts) never shadows the payload's main one.
 */
function listedItems(payload: unknown, valueField: string): unknown[] | undefined {
  let level: unknown[] = [payload];
  for (let depth = 0; depth <= 2 && level.length > 0; depth += 1) {
    const next: unknown[] = [];
    for (const value of level) {
      if (Array.isArray(value)) {
        if (carriesValues(value, valueField)) return value;
      } else if (isRecord(value)) {
        next.push(...Object.values(value));
      }
    }
    level = next;
  }
  return undefined;
}

/**
 * The account's distinct values for a parameter from its resolver's result.
 * An error result or an unrecognised shape yields none.
 */
export function accountChoicesFromResult(
  parameter: McpAccountParameter,
  result: unknown,
): McpAccountChoice[] {
  if (isRecord(result) && result.isError === true) return [];
  for (const payload of resultPayloads(result)) {
    const items = listedItems(payload, parameter.valueField);
    if (!items) continue;
    const choices = new Map<string, McpAccountChoice>();
    for (const item of items) {
      if (!isRecord(item)) continue;
      const value = text(item[parameter.valueField]);
      if (!value || choices.has(value)) continue;
      const label = parameter.labelFields.map((field) => text(item[field])).find(Boolean);
      choices.set(value, label ? { value, label } : { value });
      if (choices.size >= MAX_ACCOUNT_CHOICES) break;
    }
    return [...choices.values()];
  }
  return [];
}

/**
 * Whether a supplied value leaves the parameter unset: missing, empty, or a
 * phrase. Identifiers (ids, host names, URLs) never contain whitespace; a
 * value only padded with it is still sent as it is.
 */
export function accountParameterUnset(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed === "" || /\s/u.test(trimmed);
}

export type AccountParameterFill =
  | { kind: "arguments"; arguments: Record<string, unknown> }
  | { kind: "choose"; parameter: string; choices: readonly McpAccountChoice[] };

/**
 * Fill each unset account parameter: the account's only value, or the value of
 * the choice the model named. Several values and no match ask the model to
 * choose. A plausible supplied value is never replaced, and a lookup that
 * finds nothing leaves the argument as it was.
 */
export async function fillAccountParameters(
  parameters: readonly McpAccountParameter[],
  args: Record<string, unknown>,
  choicesFor: (parameter: McpAccountParameter) => Promise<readonly McpAccountChoice[]>,
): Promise<AccountParameterFill> {
  let filled = args;
  for (const parameter of parameters) {
    const supplied = args[parameter.name];
    if (!accountParameterUnset(supplied)) continue;
    const choices = await choicesFor(parameter);
    if (choices.length === 0) continue;
    const named =
      typeof supplied === "string" && supplied.trim()
        ? choices.find((choice) => choice.label?.toLowerCase() === supplied.trim().toLowerCase())
        : undefined;
    const choice = named ?? (choices.length === 1 ? choices[0] : undefined);
    if (!choice) return { kind: "choose", parameter: parameter.name, choices };
    filled = { ...filled, [parameter.name]: choice.value };
  }
  return { kind: "arguments", arguments: filled };
}

const MAX_LISTED_CHOICES = 25;

/** Model-facing text asking for one of the account's values. */
export function accountParameterChoiceText(
  parameter: string,
  choices: readonly McpAccountChoice[],
): string {
  const listed = choices
    .slice(0, MAX_LISTED_CHOICES)
    .map((choice) =>
      choice.label ? `${JSON.stringify(choice.label)} (${choice.value})` : choice.value,
    )
    .join(", ");
  const more =
    choices.length > MAX_LISTED_CHOICES ? ` and ${choices.length - MAX_LISTED_CHOICES} more` : "";
  return `The tool was not called: the connected account has several values for ${parameter}. Call it again with ${parameter} set to the id of the one you mean: ${listed}${more}.`;
}

/**
 * Thrown when the model must choose one of the account's values. Nothing was
 * sent to the provider, so a connector action settles as not executed; its
 * message is the model-facing choice text.
 */
export class McpAccountParameterChoiceError extends Error {
  override readonly name = "McpAccountParameterChoiceError";
  readonly connectorActionOutcome = "not_executed" as const;

  constructor(
    readonly parameter: string,
    readonly choices: readonly McpAccountChoice[],
  ) {
    super(accountParameterChoiceText(parameter, choices));
  }
}

/** `instanceof` that tolerates hostile errors whose prototype lookup throws. */
export function isMcpAccountParameterChoiceError(
  error: unknown,
): error is McpAccountParameterChoiceError {
  try {
    return error instanceof McpAccountParameterChoiceError;
  } catch {
    return false;
  }
}
