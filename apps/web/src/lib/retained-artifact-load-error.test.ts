import { describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";

import { ApiError } from "../api";
import { retainedArtifactLoadErrorPresentation } from "./retained-artifact-load-error";

const unavailableCopy = {
  title: "Artifact unavailable",
  description:
    "This file isn't available. It may have been removed, or you may not have access to it.",
};

function assertNoRawApiPhrasing(presentation: { title: string; description: string }) {
  const serialized = JSON.stringify(presentation);
  expect(serialized).not.toContain("OpenGeni API");
  expect(serialized).not.toContain("API 404");
  expect(serialized).not.toContain("artifact not found");
}

describe("retained artifact load error presentation", () => {
  test("treats 403 and 404 as the same unavailable copy without retry", () => {
    const forbidden = retainedArtifactLoadErrorPresentation(
      new OpenGeniApiError(403, JSON.stringify({ error: { message: "forbidden" } }), {
        correlationId: "corr-403",
      }),
    );
    const missing = retainedArtifactLoadErrorPresentation(
      new OpenGeniApiError(404, JSON.stringify({ error: { message: "artifact not found" } }), {
        correlationId: "corr-404",
      }),
    );

    expect(forbidden.title).toBe(unavailableCopy.title);
    expect(forbidden.description).toBe(unavailableCopy.description);
    expect(forbidden.retryable).toBe(false);
    expect(missing.title).toBe(forbidden.title);
    expect(missing.description).toBe(forbidden.description);
    expect(missing.retryable).toBe(false);
    expect(forbidden.supportReference).toBe("corr-403");
    expect(missing.supportReference).toBe("corr-404");
    assertNoRawApiPhrasing(forbidden);
    assertNoRawApiPhrasing(missing);
  });

  test("covers malformed ids and valid missing UUIDs as not-found", () => {
    const malformed = retainedArtifactLoadErrorPresentation(
      new OpenGeniApiError(404, JSON.stringify({ error: { message: "artifact not found" } })),
    );
    const missingUuid = retainedArtifactLoadErrorPresentation(
      new OpenGeniApiError(404, JSON.stringify({ error: { message: "artifact not found" } })),
    );
    expect(malformed).toEqual({
      ...unavailableCopy,
      retryable: false,
      supportReference: null,
    });
    expect(missingUuid).toEqual(malformed);
  });

  test("keeps retry for network and server failures", () => {
    expect(retainedArtifactLoadErrorPresentation(new TypeError("Failed to fetch"))).toEqual({
      title: "Couldn't load this file",
      description: "The app could not reach OpenGeni. Check your connection and try again.",
      retryable: true,
      supportReference: null,
    });

    const server = retainedArtifactLoadErrorPresentation(
      new OpenGeniApiError(503, JSON.stringify({ error: { message: "unavailable" } }), {
        correlationId: "corr-503",
        retryable: true,
      }),
    );
    expect(server.retryable).toBe(true);
    expect(server.title).toBe("Couldn't load this file");
    expect(server.supportReference).toBe("corr-503");
    assertNoRawApiPhrasing(server);
  });

  test("does not retry the local unavailable sentinel or generic errors", () => {
    expect(
      retainedArtifactLoadErrorPresentation(new Error("This artifact is no longer available.")),
    ).toEqual({
      ...unavailableCopy,
      retryable: false,
      supportReference: null,
    });

    expect(retainedArtifactLoadErrorPresentation(new Error("Artifact could not be loaded."))).toEqual(
      {
        ...unavailableCopy,
        retryable: false,
        supportReference: null,
      },
    );
  });

  test("does not expose ApiError body text", () => {
    const presentation = retainedArtifactLoadErrorPresentation(
      new ApiError(404, '{"error":{"message":"artifact not found"}}'),
    );
    expect(presentation).toEqual({
      ...unavailableCopy,
      retryable: false,
      supportReference: null,
    });
    assertNoRawApiPhrasing(presentation);
  });
});
