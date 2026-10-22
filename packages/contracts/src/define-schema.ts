/**
 * Construct a schema eagerly, but give bundlers one removable boundary around
 * the whole initializer (including nested schemas and chained builders).
 * Annotate calls with @__PURE__ only when the factory has no effects beyond
 * constructing its returned schema. This is not lazy validation: used schemas
 * are created once, in the same module evaluation order as ordinary constants.
 */
export function defineSchema<Schema>(factory: () => Schema): Schema {
  return factory();
}
