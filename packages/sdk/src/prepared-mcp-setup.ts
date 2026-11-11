import type {
  CustomMcpSetupRequest,
  PreparedMcpSetup,
} from "@opengeni/contracts/prepared-mcp-setup";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const text = (value: unknown, max: number, min = 1): value is string =>
  typeof value === "string" && value.length >= min && value.length <= max;
const trimmedText = (value: unknown, max: number): value is string =>
  typeof value === "string" && text(value.trim(), max);
const headerPart = (value: unknown): value is string =>
  text(value, 16_384, 0) && !/[\r\n\0]/.test(value);
const fieldId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value);
const endpoint = (value: unknown): value is string => {
  if (!text(value, 2048)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
};

/** Browser/native-safe display projection. The API owns authoritative schema
 * validation; parity tests keep this lightweight parser aligned without pulling
 * schema runtimes into the SDK or replaying unknown fields into a secret form. */
export function parseCustomMcpSetupRequest(value: unknown): CustomMcpSetupRequest | null {
  if (
    !record(value) ||
    !keys(value, ["kind", "name", "endpointUrl", "rationale", "ownership", "mcpSetup"]) ||
    value.kind !== "mcp" ||
    !trimmedText(value.name, 256) ||
    !endpoint(value.endpointUrl) ||
    !trimmedText(value.rationale, 2000)
  )
    return null;
  const base = {
    kind: "mcp" as const,
    name: value.name.trim(),
    endpointUrl: value.endpointUrl,
    rationale: value.rationale.trim(),
  };
  if (value.ownership === undefined && value.mcpSetup === undefined) return base;
  if (value.ownership !== "personal" && value.ownership !== "workspace") return null;
  const setup = value.mcpSetup;
  if (
    !record(setup) ||
    !keys(setup, ["name", "endpointUrl", "headers", "secretFields"]) ||
    !trimmedText(setup.name, 256) ||
    setup.name.trim() !== base.name ||
    setup.endpointUrl !== base.endpointUrl ||
    !Array.isArray(setup.headers) ||
    setup.headers.length < 1 ||
    setup.headers.length > 32 ||
    !Array.isArray(setup.secretFields) ||
    setup.secretFields.length > 32
  )
    return null;
  const fields: PreparedMcpSetup["secretFields"] = [];
  const fieldIds = new Set<string>();
  for (const field of setup.secretFields) {
    if (
      !record(field) ||
      !keys(field, ["id", "label"]) ||
      !fieldId(field.id) ||
      !trimmedText(field.label, 256) ||
      fieldIds.has(field.id)
    )
      return null;
    fieldIds.add(field.id);
    fields.push({ id: field.id, label: field.label.trim() });
  }
  const headers: PreparedMcpSetup["headers"] = [];
  const names = new Set<string>();
  const used = new Set<string>();
  for (const header of setup.headers) {
    if (
      !record(header) ||
      !text(header.name, 256) ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header.name)
    )
      return null;
    const name = header.name.toLowerCase();
    if (names.has(name)) return null;
    names.add(name);
    if ("value" in header) {
      if (
        !keys(header, ["name", "value"]) ||
        !headerPart(header.value) ||
        !header.value ||
        ["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key"].includes(name)
      )
        return null;
      headers.push({ name: header.name, value: header.value });
    } else {
      if (
        !keys(header, ["name", "secret", "prefix", "suffix"]) ||
        !fieldId(header.secret) ||
        !fieldIds.has(header.secret) ||
        (header.prefix !== undefined && !headerPart(header.prefix)) ||
        (header.suffix !== undefined && !headerPart(header.suffix))
      )
        return null;
      used.add(header.secret);
      headers.push({
        name: header.name,
        secret: header.secret,
        ...(header.prefix !== undefined ? { prefix: header.prefix as string } : {}),
        ...(header.suffix !== undefined ? { suffix: header.suffix as string } : {}),
      });
    }
  }
  if (used.size !== fieldIds.size) return null;
  return {
    ...base,
    ownership: value.ownership,
    mcpSetup: { name: base.name, endpointUrl: base.endpointUrl, headers, secretFields: fields },
  };
}
