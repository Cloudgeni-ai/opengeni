import { describe, expect, test } from "bun:test";
import {
  INLINE_OPENAPI_DOCUMENT_MAX_BYTES,
  IntegrationSource,
  PreviewApiIntegrationRequest,
} from "../src/index";

describe("inline OpenAPI document source", () => {
  const source = { kind: "openapi_document", sourceKey: "product-api", document: "{}" };

  test("preview/install accept it within the byte bound", () => {
    expect(PreviewApiIntegrationRequest.safeParse({ source }).success).toBe(true);
    expect(
      PreviewApiIntegrationRequest.safeParse({
        source: { ...source, document: "x".repeat(INLINE_OPENAPI_DOCUMENT_MAX_BYTES + 1) },
      }).success,
    ).toBe(false);
    expect(
      PreviewApiIntegrationRequest.safeParse({ source: { ...source, sourceKey: "../x" } }).success,
    ).toBe(false);
  });

  test("stored/Pack integration sources stay URL-only", () => {
    expect(IntegrationSource.safeParse(source).success).toBe(false);
  });
});
