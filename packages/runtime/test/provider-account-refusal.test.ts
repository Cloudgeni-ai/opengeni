import { describe, expect, test } from "bun:test";
import { APIError } from "openai";
import {
  classifyProviderAccountRefusal,
  classifyProviderAccountRefusalError,
  classifyProviderAccountRefusalResponse,
  classifyProviderQuotaError,
} from "../src/provider-quota";
import { CompactionProviderResponseError } from "../src/context-compaction";

const BYOK_MESSAGE =
  "No endpoints found that can be served by your own provider keys. This workspace is restricted to BYOK capacity and has no provider key eligible for this request. Add provider keys at https://openrouter.ai/workspaces/default/byok";

function sdkError(status: number, error: Record<string, unknown>) {
  return APIError.generate(status, { error }, undefined, new Headers());
}

describe("provider account refusals", () => {
  test("OpenRouter's BYOK-only restriction is the customer's account, from its 404 and wording", () => {
    const error = sdkError(404, { message: BYOK_MESSAGE, code: 404 });
    expect(error.message.startsWith("404 No endpoints found")).toBe(true);
    expect(classifyProviderAccountRefusalError(error)).toBe("byok_capacity_restricted");
    // Either restriction phrase alone is specific enough.
    expect(
      classifyProviderAccountRefusal({
        status: 404,
        texts: ["This workspace is restricted to BYOK capacity."],
      }),
    ).toBe("byok_capacity_restricted");
    // A wrapper that kept only the "404 ..." message prefix.
    expect(classifyProviderAccountRefusal({ status: null, texts: [`404 ${BYOK_MESSAGE}`] })).toBe(
      "byok_capacity_restricted",
    );
  });

  test("other 404s, request faults and the same wording on another status stay unclassified", () => {
    for (const message of [
      "No endpoints found for some/model.",
      "No endpoints found that support tool use. To learn more about provider routing, visit: https://openrouter.ai/docs/provider-routing",
      "No endpoints found that can handle the requested parameters.",
      "No endpoints found matching your data policy (Free model publication).",
      "Not Found",
    ]) {
      expect(classifyProviderAccountRefusalError(sdkError(404, { message, code: 404 }))).toBeNull();
    }
    for (const status of [400, 422, 500, 503]) {
      expect(
        classifyProviderAccountRefusalError(sdkError(status, { message: BYOK_MESSAGE })),
      ).toBeNull();
    }
    expect(classifyProviderAccountRefusalError(new Error("Connection error."))).toBeNull();
    expect(classifyProviderAccountRefusalError(new Error(BYOK_MESSAGE))).toBeNull();
  });

  test("a failed compaction request carries the same evidence through its cause", () => {
    const cause = sdkError(404, { message: BYOK_MESSAGE, code: 404 });
    const compaction = new CompactionProviderResponseError({ httpStatus: 404 }, cause);
    expect(compaction.message).toContain("Compaction provider request failed");
    expect(classifyProviderAccountRefusalError(compaction)).toBe("byok_capacity_restricted");
    const generic = new CompactionProviderResponseError(
      { httpStatus: 404 },
      sdkError(404, { message: "Not Found" }),
    );
    expect(classifyProviderAccountRefusalError(generic)).toBeNull();
  });

  test("Vercel AI Gateway: verification is an account refusal by structured type; credits and budgets are quota", () => {
    expect(
      classifyProviderAccountRefusalError(
        sdkError(403, {
          message: "Add a payment method to use free credits.",
          type: "customer_verification_required",
        }),
      ),
    ).toBe("customer_verification_required");
    // A 403 without that type (for example a team model allowlist) is not classified here.
    expect(
      classifyProviderAccountRefusalError(
        sdkError(403, { message: "Forbidden", type: "forbidden" }),
      ),
    ).toBeNull();
    expect(
      classifyProviderQuotaError(
        sdkError(402, {
          message: "Insufficient funds. Please add credits to your account to continue.",
          type: "insufficient_funds",
        }),
      ),
    ).toEqual({ scope: "credits" });
    expect(
      classifyProviderQuotaError(
        sdkError(402, { message: "Project budget exceeded.", type: "quota_for_entity_exceeded" }),
      ),
    ).not.toBeNull();
  });

  test("responses are read from a bounded clone, leaving the body for the caller", async () => {
    const body = JSON.stringify({ error: { message: BYOK_MESSAGE, code: 404 } });
    const response = new Response(body, { status: 404 });
    expect(await classifyProviderAccountRefusalResponse(response)).toBe("byok_capacity_restricted");
    expect(await response.text()).toBe(body);
    expect(
      await classifyProviderAccountRefusalResponse(new Response(body, { status: 400 })),
    ).toBeNull();
    expect(
      await classifyProviderAccountRefusalResponse(
        new Response("x".repeat(70_000), { status: 404 }),
      ),
    ).toBeNull();
  });

  test("OpenRouter key and budget limits on the customer's own key are account refusals only on 403", () => {
    for (const message of [
      "Key limit exceeded (total limit). Manage it using https://openrouter.ai/settings/keys",
      "Key limit exceeded (monthly limit)",
      "Budget limit exceeded (monthly limit)",
      "API key budget limit exceeded",
    ]) {
      expect(classifyProviderAccountRefusalError(sdkError(403, { message, code: 403 }))).toBe(
        "key_limit_exceeded",
      );
      for (const status of [400, 401, 404, 500]) {
        expect(classifyProviderAccountRefusalError(sdkError(status, { message }))).toBeNull();
      }
    }
    // Other 403s (moderation, region, model allowlists) stay unclassified.
    for (const message of ["Forbidden", "Your input was flagged by moderation", "Key disabled"]) {
      expect(classifyProviderAccountRefusalError(sdkError(403, { message }))).toBeNull();
    }
  });

  test("a refused body that stalls is left unclassified after the read deadline", async () => {
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":{"message":"No endpoints'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(stalled, { status: 404 });
    expect(await classifyProviderAccountRefusalResponse(response, 20)).toBeNull();
    await response.body?.cancel();
    expect(cancelled).toBe(true);
  });
});
