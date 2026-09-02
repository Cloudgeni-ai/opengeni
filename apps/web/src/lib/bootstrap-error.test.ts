import { describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";

import { ApiError } from "../api";
import { bootstrapErrorPresentation } from "./bootstrap-error";

describe("bootstrap error presentation", () => {
  test("turns the maintenance API payload into calm maintenance copy", () => {
    const presentation = bootstrapErrorPresentation(
      new ApiError(503, JSON.stringify({ error: "maintenance" })),
      "client_configuration",
    );

    expect(presentation).toEqual({
      title: "OpenGeni is under maintenance",
      description: "We'll be back shortly. Try again in a moment.",
    });
  });

  test("recognizes typed nested maintenance responses", () => {
    const presentation = bootstrapErrorPresentation(
      new OpenGeniApiError(503, JSON.stringify({ error: { code: "maintenance_mode" } })),
      "workspace_access",
    );

    expect(presentation.title).toBe("OpenGeni is under maintenance");
  });

  test("does not expose proxy HTML or API framing", () => {
    const presentation = bootstrapErrorPresentation(
      new ApiError(502, "<!doctype html><html><body><div>upstream failed</div></body></html>"),
      "client_configuration",
    );

    expect(presentation).toEqual({
      title: "OpenGeni is temporarily unavailable",
      description: "The service could not finish loading. Try again shortly.",
    });
    expect(JSON.stringify(presentation)).not.toContain("<div>");
    expect(JSON.stringify(presentation)).not.toContain("API 502");
  });

  test("explains a successful non-JSON config response without showing parser output", () => {
    const presentation = bootstrapErrorPresentation(
      new SyntaxError("Unexpected token '<', \"<!doctype\" is not valid JSON"),
      "client_configuration",
    );

    expect(presentation).toEqual({
      title: "OpenGeni couldn't start",
      description:
        "The API returned an invalid configuration response. Check the deployment or proxy configuration, then try again.",
    });
    expect(JSON.stringify(presentation)).not.toContain("Unexpected token");
  });

  test("distinguishes network failures from deployment configuration failures", () => {
    expect(
      bootstrapErrorPresentation(new TypeError("Failed to fetch"), "client_configuration"),
    ).toEqual({
      title: "OpenGeni is unreachable",
      description: "The app could not reach the OpenGeni API. Check your connection and try again.",
    });

    expect(
      bootstrapErrorPresentation(
        new ApiError(500, "internal configuration failure"),
        "client_configuration",
      ),
    ).toEqual({
      title: "OpenGeni couldn't start",
      description:
        "The client configuration could not be loaded. Check the deployment settings and server logs, then try again.",
    });
  });

  test("keeps workspace-access failures concise", () => {
    const presentation = bootstrapErrorPresentation(
      new ApiError(403, "<div>forbidden by proxy</div>"),
      "workspace_access",
    );

    expect(presentation).toEqual({
      title: "Workspace access unavailable",
      description: "OpenGeni couldn't load your workspace access. Try again.",
    });
    expect(JSON.stringify(presentation)).not.toContain("forbidden by proxy");
  });
});
