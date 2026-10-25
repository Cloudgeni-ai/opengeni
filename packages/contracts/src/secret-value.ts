import { z } from "zod";

/**
 * Schemas whose value is a secret: a password, key, token, or a bundle of
 * credential headers or values. The action catalog generator reads this
 * registry, so every action whose request or response carries such a field is
 * marked as handling secrets wherever the schema is reused, whatever the
 * field is called. Field names that already say "secret" ("apiKey",
 * "clientSecret") are caught by name as well.
 */
export const secretValues = z.registry<{ secret: true }, z.ZodType>();

/**
 * Mark a schema as holding a secret value. Pass the schema built for this
 * field ("z.record(...)"), never a shared one such as a primitive: the mark
 * belongs to the schema instance, so marking a shared one would mark every
 * field that uses it.
 */
export function secretValue<Schema extends z.ZodType>(schema: Schema): Schema {
  secretValues.add(schema as z.ZodType, { secret: true });
  return schema;
}
