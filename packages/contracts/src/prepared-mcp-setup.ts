import { z } from "zod";

const fieldId = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const headerName = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/);
const headerPart = z
  .string()
  .max(16_384)
  .regex(/^[^\r\n\0]*$/);

/** Configuration is safe to retain; secret values enter only the protected
 * Connect credential request, never this model-visible setup description. */
export const PreparedMcpSetup = z
  .object({
    name: z.string().trim().min(1).max(256),
    endpointUrl: z
      .string()
      .url()
      .max(2048)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
          );
        } catch {
          return false;
        }
      }, "Use an HTTPS endpoint without credentials, query parameters, or a fragment"),
    headers: z
      .array(
        z.union([
          z.object({ name: headerName, value: headerPart.min(1) }).strict(),
          z
            .object({
              name: headerName,
              secret: fieldId,
              prefix: headerPart.optional(),
              suffix: headerPart.optional(),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(32),
    secretFields: z
      .array(z.object({ id: fieldId, label: z.string().trim().min(1).max(256) }).strict())
      .max(32),
  })
  .strict()
  .superRefine((value, context) => {
    const names = value.headers.map((header) => header.name.toLowerCase());
    const ids = value.secretFields.map((field) => field.id);
    if (new Set(names).size !== names.length)
      context.addIssue({
        code: "custom",
        path: ["headers"],
        message: "Header names must be unique",
      });
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: "custom",
        path: ["secretFields"],
        message: "Secret field IDs must be unique",
      });
    const used = new Set(
      value.headers.flatMap((header) => ("secret" in header ? [header.secret] : [])),
    );
    if (used.size !== ids.length || ids.some((id) => !used.has(id)))
      context.addIssue({
        code: "custom",
        path: ["secretFields"],
        message: "Declare exactly the secret fields used by the headers",
      });
    for (const [index, header] of value.headers.entries()) {
      if (
        "value" in header &&
        ["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key"].includes(
          header.name.toLowerCase(),
        )
      )
        context.addIssue({
          code: "custom",
          path: ["headers", index],
          message: "Credential headers must reference a protected secret field",
        });
    }
  });
export type PreparedMcpSetup = z.infer<typeof PreparedMcpSetup>;

/** A missing-key proposal retains configuration only. Ownership is explicit
 * and the displayed identity must equal the destination actually configured. */
export const CustomMcpSetupRequest = z
  .object({
    kind: z.literal("mcp"),
    name: z.string().trim().min(1).max(256),
    endpointUrl: z
      .string()
      .url()
      .max(2048)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.search
          );
        } catch {
          return false;
        }
      }),
    rationale: z.string().trim().min(1).max(2000),
    ownership: z.enum(["personal", "workspace"]).optional(),
    mcpSetup: PreparedMcpSetup.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.ownership) !== Boolean(value.mcpSetup))
      context.addIssue({ code: "custom", message: "Prepared setup requires explicit ownership" });
    if (
      value.mcpSetup &&
      (value.name !== value.mcpSetup.name || value.endpointUrl !== value.mcpSetup.endpointUrl)
    )
      context.addIssue({
        code: "custom",
        message: "Prepared setup must match the displayed server",
      });
  });
export type CustomMcpSetupRequest = z.infer<typeof CustomMcpSetupRequest>;

/** Values are intentionally accepted separately. Errors name neither supplied
 * values nor undeclared input keys, which may themselves contain credentials. */
export function preparedMcpHeaders(
  configuration: PreparedMcpSetup,
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const setup = PreparedMcpSetup.parse(configuration);
  const supplied = Object.keys(values);
  if (
    supplied.length !== setup.secretFields.length ||
    setup.secretFields.some((field) => !Object.hasOwn(values, field.id)) ||
    supplied.some((key) => {
      const value = values[key];
      return (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 16_384 ||
        /[\r\n\0]/.test(value)
      );
    })
  )
    throw new Error("Supply exactly the requested secret fields");
  const headers: Record<string, string> = {};
  for (const header of setup.headers) {
    const value =
      "value" in header
        ? header.value
        : `${header.prefix ?? ""}${values[header.secret]}${header.suffix ?? ""}`;
    if (value.length > 16_384) throw new Error("Prepared credential header is too long");
    Object.defineProperty(headers, header.name, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return headers;
}
