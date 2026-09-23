import type { AttemptToolJsonSchema } from "@opengeni/contracts";
import { z } from "zod";

/** Keep repeated browser action and locator variants once in the model schema. */
export function browserActionInputJsonSchema(schema: z.ZodType): AttemptToolJsonSchema {
  return z.toJSONSchema(schema, {
    target: "draft-2020-12",
    reused: "ref",
  }) as AttemptToolJsonSchema;
}
