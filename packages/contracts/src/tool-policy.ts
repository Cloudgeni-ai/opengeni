/** Only a declared action discriminator can select an action-specific preference.
 * Callers still validate the complete arguments against the tool schema. */
export function toolPolicyActionName(
  toolName: string,
  inputSchema: unknown,
  args: unknown,
): string {
  if (
    !inputSchema ||
    typeof inputSchema !== "object" ||
    Array.isArray(inputSchema) ||
    !args ||
    typeof args !== "object" ||
    Array.isArray(args)
  )
    return toolName;
  const properties = (inputSchema as Record<string, unknown>).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return toolName;
  const actionSchema = (properties as Record<string, unknown>).action;
  const action = (args as Record<string, unknown>).action;
  if (
    !actionSchema ||
    typeof actionSchema !== "object" ||
    Array.isArray(actionSchema) ||
    typeof action !== "string" ||
    !action.trim() ||
    action !== action.trim() ||
    action.length > 512
  )
    return toolName;
  const declared = actionSchema as Record<string, unknown>;
  if (declared.enum && (!Array.isArray(declared.enum) || !declared.enum.includes(action)))
    return toolName;
  if (declared.const !== undefined && declared.const !== action) return toolName;
  return declared.type === "string" || declared.enum !== undefined || declared.const !== undefined
    ? action
    : toolName;
}

/** Strip only JSON Schema annotations, never object property names or literal values. */
export function executableToolSchema(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const annotations = new Set(["title", "description", "examples", "$comment"]);
  const schemaMaps = new Set([
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
    "dependentSchemas",
  ]);
  const schemaLists = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
  const schemaValues = new Set([
    "items",
    "contains",
    "additionalProperties",
    "unevaluatedProperties",
    "unevaluatedItems",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
  ]);
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      if (annotations.has(key)) return [];
      if (schemaMaps.has(key) && entry && typeof entry === "object" && !Array.isArray(entry))
        return [
          [
            key,
            Object.fromEntries(
              Object.entries(entry).map(([name, schema]) => [name, executableToolSchema(schema)]),
            ),
          ],
        ];
      if (schemaLists.has(key) && Array.isArray(entry))
        return [[key, entry.map(executableToolSchema)]];
      if (schemaValues.has(key)) return [[key, executableToolSchema(entry)]];
      return [[key, entry]];
    }),
  );
}
