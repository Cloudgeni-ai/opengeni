import * as z from "zod/v4";

/**
 * Publish the input side of a contract, validate it, and retain the exact call.
 * MCP parsing must not insert defaults, trim text, or erase omitted fields before
 * the application applies presence-sensitive inheritance and authority rules.
 * A narrower projection may hide host-only fields; validation retains the full
 * contract's preprocessors and cross-field checks.
 */
export function contractToolInput<T extends z.ZodObject>(
  projection: T,
  validation: z.ZodType = projection,
): z.ZodType<z.input<T>, z.input<T>> {
  const inputProjection = projection.strict();
  const jsonSchema = z.toJSONSchema(inputProjection, {
    io: "input",
    target: "draft-7",
  });
  assertDescribedToolInput(jsonSchema);
  // MCP's SDK only publishes recognized object schemas. A passthrough object
  // keeps the call intact, while metadata supplies the projected JSON Schema.
  return z
    .object({})
    .catchall(z.unknown())
    .superRefine((args, context) => {
      const projected = inputProjection.safeParse(args);
      const parsed = projected.success ? validation.safeParse(args) : projected;
      if (!parsed.success) {
        for (const issue of inputIssues(parsed.error.issues)) context.addIssue({ ...issue });
      }
    })
    .meta(jsonSchema) as unknown as z.ZodType<z.input<T>, z.input<T>>;
}

/** Every named input and array element needs a schema. Dictionary values may be arbitrary JSON. */
export function assertDescribedToolInput(schema: unknown, tool = "tool"): void {
  const activeRefs = new Set<string>();
  function visit(value: unknown, path: string, allowOpaque = false): void {
    if (value === false) return;
    if (value === true && allowOpaque) return;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${tool}: invalid input schema at ${path}`);
    }
    const node = value as Record<string, unknown>;
    const constraints = ["type", "$ref", "enum", "const", "anyOf", "oneOf", "allOf", "not"];
    if (!constraints.some((key) => Object.hasOwn(node, key))) {
      if (allowOpaque) return;
      throw new Error(`${tool}: input ${path} has no declared structure; use its contract schema`);
    }
    if (typeof node.$ref === "string" && node.$ref.startsWith("#/") && !activeRefs.has(node.$ref)) {
      const ref = node.$ref;
      let target = schema;
      for (const part of ref.slice(2).split("/")) {
        target = (target as Record<string, unknown>)?.[
          part.replace(/~1/g, "/").replace(/~0/g, "~")
        ];
      }
      activeRefs.add(ref);
      visit(target, path, allowOpaque);
      activeRefs.delete(ref);
    }
    for (const [key, child] of Object.entries((node.properties ?? {}) as Record<string, unknown>)) {
      visit(child, `${path}.${key}`);
    }
    if (node.type === "array" && node.items === undefined && node.prefixItems === undefined) {
      throw new Error(
        `${tool}: input ${path}[] has no declared structure; use its contract schema`,
      );
    }
    if (Array.isArray(node.items)) {
      node.items.forEach((child, index) => visit(child, `${path}[${index}]`));
      if (node.additionalItems !== undefined) visit(node.additionalItems, `${path}[...]`);
      else if (typeof node.maxItems !== "number" || node.maxItems > node.items.length) {
        throw new Error(
          `${tool}: input ${path}[...] has no declared structure; use its contract schema`,
        );
      }
    } else if (node.items !== undefined) visit(node.items, `${path}[]`);
    if (Array.isArray(node.prefixItems)) {
      node.prefixItems.forEach((child, index) => visit(child, `${path}[${index}]`));
      if (
        node.items === undefined &&
        (typeof node.maxItems !== "number" || node.maxItems > node.prefixItems.length)
      ) {
        throw new Error(
          `${tool}: input ${path}[...] has no declared structure; use its contract schema`,
        );
      }
    }
    // An unconstrained dictionary is intentional extension data. If its values
    // declare a structure, check that structure's fields just like named inputs.
    const dictionary = node.additionalProperties;
    if (dictionary && typeof dictionary === "object" && Object.keys(dictionary).length > 0) {
      visit(dictionary, `${path}.*`, true);
    }
    for (const [key, child] of Object.entries(
      (node.patternProperties ?? {}) as Record<string, unknown>,
    )) {
      if (child && typeof child === "object" && Object.keys(child).length === 0) continue;
      visit(child, `${path}.[${key}]`, true);
    }
    for (const keyword of ["anyOf", "oneOf", "allOf"]) {
      for (const [index, child] of ((node[keyword] ?? []) as unknown[]).entries()) {
        visit(child, `${path}.${keyword}[${index}]`, allowOpaque);
      }
    }
  }
  visit(schema, "arguments");
}

/** Only raw contract preflight errors, never downstream provider or storage exceptions. */
function inputIssues(issues: readonly z.core.$ZodIssue[]): z.core.$ZodIssueCustom[] {
  const result: z.core.$ZodIssueCustom[] = [];
  for (const issue of issues.slice(0, 8)) {
    const path = [...issue.path];
    let message: string;
    if (issue.code === "invalid_type") message = `expected ${issue.expected}`;
    else if (issue.code === "invalid_value")
      message = `allowed values: ${JSON.stringify(issue.values)}`;
    else if (issue.code === "invalid_union" && issue.errors.length === 0 && issue.discriminator) {
      if (path.at(-1) !== issue.discriminator) path.push(issue.discriminator);
      message = `allowed values: ${JSON.stringify("options" in issue ? issue.options : [])}`;
    } else if (issue.code === "invalid_union") {
      // These are alternatives, never cumulative requirements.
      message = "does not match any of the declared alternative input formats";
    } else if (issue.code === "unrecognized_keys")
      message = `fields not declared by this tool: ${JSON.stringify(issue.keys)}`;
    else if (issue.code === "too_small") message = `must meet minimum ${issue.minimum}`;
    else if (issue.code === "too_big") message = `must meet maximum ${issue.maximum}`;
    else message = issue.message;
    result.push({ code: "custom", path, message });
  }
  if (issues.length > 8) {
    result.push({
      code: "custom",
      path: [],
      message: `${issues.length - 8} additional input problems`,
    });
  }
  return result;
}
