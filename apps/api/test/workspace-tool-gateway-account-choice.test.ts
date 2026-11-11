import { describe, expect, test } from "bun:test";
import { McpAccountParameterChoiceError } from "@opengeni/runtime";

import { ApiHttpError } from "../src/http/api-error";
import { throwWorkspaceToolGatewayHttpError } from "../src/workspace-tool-gateway";

describe("workspace tool gateway account value choice", () => {
  test("maps to a not-executed 422 that names the choices", () => {
    let caught: unknown;
    try {
      throwWorkspaceToolGatewayHttpError(
        new McpAccountParameterChoiceError("siteId", [
          { value: "site-1", label: "Alpha" },
          { value: "site-2", label: "Beta" },
        ]),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiHttpError);
    const error = caught as ApiHttpError;
    expect(error.status).toBe(422);
    expect(error.code).toBe("validation_failed");
    expect(error.outcomeUnknown).toBe(false);
    expect(error.retryable).toBe(false);
    expect(error.details).toEqual({
      code: "account_parameter_choice_required",
      parameter: "siteId",
    });
    expect(error.message).toContain(`"Beta" (site-2)`);
  });
});
