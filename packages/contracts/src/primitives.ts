import { z } from "zod";
import { defineSchema } from "./define-schema";

/**
 * Reuse common validators instead of retaining thousands of identical Zod
 * instances. These are ordinary eager schemas, not a validation cache. Zod's
 * builder methods return derived schemas; attach field-specific metadata to a
 * derived schema rather than mutating a shared primitive's registry entry.
 */
export const string = /* @__PURE__ */ defineSchema(() => z.string());
export const boolean = /* @__PURE__ */ defineSchema(() => z.boolean());
export const uuid = /* @__PURE__ */ defineSchema(() => z.string().uuid());
export const nonnegativeInteger = /* @__PURE__ */ defineSchema(() =>
  z.number().int().nonnegative(),
);
export const positiveInteger = /* @__PURE__ */ defineSchema(() => z.number().int().positive());
export const nullableString = /* @__PURE__ */ defineSchema(() => string.nullable());
export const nonEmptyString = /* @__PURE__ */ defineSchema(() => string.min(1));
export const nullableUuid = /* @__PURE__ */ defineSchema(() => uuid.nullable());
export const optionalBoolean = /* @__PURE__ */ defineSchema(() => boolean.optional());
export const optionalUuid = /* @__PURE__ */ defineSchema(() => uuid.optional());
export const dateTime = /* @__PURE__ */ defineSchema(() => string.datetime());
