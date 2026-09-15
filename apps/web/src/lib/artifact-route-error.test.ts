import { describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";
import { artifactRouteErrorMessage, mapArtifactRouteError } from "./artifact-route-error";

describe("artifact route load errors", () => {
  for (const kind of ["site", "editable"] as const) {
    for (const status of [401, 403, 404]) {
      test(`${kind} ${status} is unavailable without retry or API status text`, () => {
        const view = mapArtifactRouteError(new OpenGeniApiError(status, ""), kind);
        expect(view.retryable).toBe(false);
        expect(view.title).toContain("isn't available");
        expect(view.message).not.toMatch(/OpenGeni API/i);
        expect(artifactRouteErrorMessage(view)).not.toMatch(/OpenGeni API/i);
      });
    }

    test(`${kind} 422 is an invalid link without retry`, () => {
      const view = mapArtifactRouteError(new OpenGeniApiError(422, ""), kind);
      expect(view.retryable).toBe(false);
      expect(view.title).toContain("isn't valid");
      expect(view.message).not.toMatch(/OpenGeni API/i);
    });

    test(`${kind} 503 is retryable by default and keeps a support reference`, () => {
      const view = mapArtifactRouteError(
        new OpenGeniApiError(503, "", { correlationId: "req_abc-1" }),
        kind,
      );
      expect(view.retryable).toBe(true);
      expect(view.correlationId).toBe("req_abc-1");
      expect(artifactRouteErrorMessage(view)).toContain("Reference: req_abc-1");
      expect(artifactRouteErrorMessage(view)).not.toMatch(/OpenGeni API/i);
    });

    test(`${kind} network TypeError is retryable`, () => {
      const view = mapArtifactRouteError(new TypeError("Failed to fetch"), kind);
      expect(view.retryable).toBe(true);
      expect(view.message).not.toContain("Failed to fetch");
    });
  }

  test("401 and 404 share the same non-disclosing copy", () => {
    expect(mapArtifactRouteError(new OpenGeniApiError(401, ""), "site")).toEqual(
      mapArtifactRouteError(new OpenGeniApiError(404, ""), "site"),
    );
  });
});
