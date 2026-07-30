import { describe, expect, test } from "bun:test";

import {
  isExpectedDisabledMachinesConsoleError,
  isExpectedDisabledMachinesResponse,
} from "./knowledge-surfaces.diagnostics";

const disabledMachinesUrl =
  "http://127.0.0.1:8000/v1/workspaces/workspace-1/machines?sessionId=session-1";

describe("knowledge-surface browser diagnostics", () => {
  test("accepts only the disabled feature's exact machines GET 404", () => {
    expect(
      isExpectedDisabledMachinesResponse(
        { status: 404, method: "GET", url: disabledMachinesUrl },
        false,
      ),
    ).toBe(true);
    expect(
      isExpectedDisabledMachinesResponse(
        { status: 404, method: "GET", url: disabledMachinesUrl },
        true,
      ),
    ).toBe(false);
  });

  test("keeps unexpected statuses, methods, paths, and console errors visible", () => {
    const unexpected = [
      { status: 500, method: "GET", url: disabledMachinesUrl },
      {
        status: 404,
        method: "GET",
        url: "http://127.0.0.1:8000/v1/workspaces/workspace-1/machines/node-1/metrics/series",
      },
      { status: 404, method: "POST", url: disabledMachinesUrl },
      { status: 404, method: "GET", url: "http://127.0.0.1:8000/assets/app.js" },
    ];
    for (const response of unexpected) {
      expect(isExpectedDisabledMachinesResponse(response, false)).toBe(false);
    }

    const expectedUrls = new Set([disabledMachinesUrl]);
    expect(
      isExpectedDisabledMachinesConsoleError(
        {
          text: "Failed to load resource: the server responded with a status of 404 (Not Found)",
          locationUrl: disabledMachinesUrl,
        },
        false,
        expectedUrls,
      ),
    ).toBe(true);
    expect(
      isExpectedDisabledMachinesConsoleError(
        {
          text: "Failed to load resource: the server responded with a status of 404 (Not Found)",
          locationUrl: "http://127.0.0.1:8000/assets/app.js",
        },
        false,
        expectedUrls,
      ),
    ).toBe(false);
    expect(
      isExpectedDisabledMachinesConsoleError(
        {
          text: "Failed to load resource: the server responded with a status of 404 (Not Found)",
          locationUrl: disabledMachinesUrl,
        },
        true,
        expectedUrls,
      ),
    ).toBe(false);
  });
});
