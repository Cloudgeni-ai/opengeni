import { z } from "zod";

const identity = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const declaration = z
  .record(identity, z.record(identity, z.string().min(1)))
  .superRefine((providers, ctx) => {
    for (const [provider, models] of Object.entries(providers)) {
      if (Object.keys(models).length === 0) {
        ctx.addIssue({
          code: "custom",
          path: [provider],
          message: "failover provider needs an explicit model mapping",
        });
      }
      for (const [model, target] of Object.entries(models)) {
        if (target !== `openai/${model}`) {
          ctx.addIssue({
            code: "custom",
            path: [provider, model],
            message: "failover must preserve the exact upstream model",
          });
        }
      }
    }
  });

/** Deployment-owned, same-model Azure Responses routes. No credentials here. */
export function parseAzureGatewayFailoverJson(
  value: string,
): Record<string, Record<string, string>> {
  const parsed: unknown = JSON.parse(value);
  const rejectsPrototype = (input: unknown): boolean => {
    if (!input || typeof input !== "object") return false;
    return Object.entries(input).some(
      ([key, child]) =>
        ["__proto__", "constructor", "prototype"].includes(key) || rejectsPrototype(child),
    );
  };
  if (rejectsPrototype(parsed)) throw new Error("invalid failover identity");
  return declaration.parse(parsed);
}
