import { ServiceTurnInitiatorContext, type AccessGrant } from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";

/** Validated provenance only. The API key remains the authenticated principal. */
export function serviceInitiatorFromHeaders(
  headers: Headers,
): Pick<AccessGrant, "serviceInitiator" | "serviceInitiatorContext"> | null {
  const name = headers.get("x-opengeni-service-initiator");
  const rawContext = headers.get("x-opengeni-service-context");
  if (name === null && rawContext === null) return null;
  if (headers.has("x-opengeni-external-actor")) {
    throw new HTTPException(422, {
      message: "service initiator and external actor (asUser) are mutually exclusive",
    });
  }
  if (name === null || !/^[a-z0-9][a-z0-9:._-]{0,63}$/.test(name)) {
    throw new HTTPException(422, {
      message: "x-opengeni-service-initiator must match ^[a-z0-9][a-z0-9:._-]{0,63}$",
    });
  }
  let context: Record<string, string | number | boolean> = {};
  if (rawContext !== null) {
    try {
      if (new TextEncoder().encode(rawContext).byteLength > 2048) throw new Error("oversize");
      const parsed: unknown = JSON.parse(rawContext);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object");
      if (
        !Object.values(parsed).every(
          (value) =>
            typeof value === "string" ||
            typeof value === "boolean" ||
            (typeof value === "number" && Number.isFinite(value)),
        )
      )
        throw new Error("flat");
      context = parsed as typeof context;
      // Keep delegated provenance's reserved, OpenGeni-owned lineage fields.
      if (!ServiceTurnInitiatorContext.safeParse(context).success) throw new Error("reserved");
    } catch {
      throw new HTTPException(422, {
        message:
          "x-opengeni-service-context must be a JSON object of flat string/number/boolean values, at most 2048 UTF-8 bytes, without reserved OpenGeni provenance fields",
      });
    }
  }
  return {
    serviceInitiator: { kind: "service", subjectId: name },
    serviceInitiatorContext: context,
  };
}
