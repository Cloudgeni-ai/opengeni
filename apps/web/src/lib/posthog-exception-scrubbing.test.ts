import { describe, expect, test } from "bun:test";

import {
  REDACTED_EXCEPTION_MESSAGE,
  leadingException,
  safeExceptionType,
  safeScriptLocation,
  scrubPosthogExceptionProperties,
} from "./posthog-exception-scrubbing";

// Every value a customer could have typed or seen carries this marker, so a
// single search of the serialized result proves none of it survives.
const SECRET = "customer-secret-7f3a";

function exceptionEvent(): Record<string, unknown> {
  return {
    token: "phc_project",
    distinct_id: "user-1",
    $os: "Mac OS X",
    $exception_level: "error",
    $exception_message: `Cannot parse "${SECRET}"`,
    $exception_type: "SyntaxError",
    $exception_values: [`Cannot parse "${SECRET}"`],
    $exception_types: ["SyntaxError"],
    $exception_fingerprint: SECRET,
    $exception_steps: [{ $message: `typed ${SECRET}`, $timestamp: "2026-11-28T12:00:00Z" }],
    $exception_personURL: `https://eu.posthog.com/person/${SECRET}`,
    exception_source: "react_boundary",
    $exception_list: [
      {
        type: "SyntaxError",
        value: `Unexpected token in JSON at position 4: "${SECRET}"`,
        module: SECRET,
        mechanism: { handled: false, synthetic: false, type: "onerror", source: SECRET },
        stacktrace: {
          type: "raw",
          frames: [
            {
              platform: "web:javascript",
              filename: `https://app.opengeni.ai/assets/index-abc123.js?token=${SECRET}#${SECRET}`,
              abs_path: `https://app.opengeni.ai/assets/index-abc123.js?token=${SECRET}`,
              function: "Object.render",
              lineno: 12,
              colno: 3456,
              in_app: true,
              chunk_id: "chunk-1",
              module: SECRET,
              context_line: `const draft = "${SECRET}";`,
              pre_context: [SECRET],
              post_context: [SECRET],
              vars: { draft: SECRET },
              instruction_addr: SECRET,
            },
            {
              platform: "web:javascript",
              // An inline script reports the page itself; a share link's
              // address is the key to the conversation.
              filename: `https://app.opengeni.ai/share/${SECRET}`,
              function: `${SECRET} "quoted" (text)`,
              lineno: -1,
              colno: 1.5,
            },
          ],
        },
      },
      {
        type: `Error: ${SECRET}`,
        value: SECRET,
        mechanism: { handled: true, exception_id: 1, parent_id: 0 },
      },
    ],
  };
}

describe("PostHog exception scrubbing", () => {
  test("keeps type, mechanism, frames and revision, and drops all content", () => {
    const scrubbed = scrubPosthogExceptionProperties(exceptionEvent(), { revision: "rev-1" });
    expect(JSON.stringify(scrubbed)).not.toContain(SECRET);
    expect(scrubbed).toEqual({
      token: "phc_project",
      distinct_id: "user-1",
      $os: "Mac OS X",
      $exception_level: "error",
      $exception_types: ["SyntaxError", "Error"],
      exception_source: "react_boundary",
      opengeni_revision: "rev-1",
      $exception_list: [
        {
          type: "SyntaxError",
          value: REDACTED_EXCEPTION_MESSAGE,
          mechanism: { handled: false, synthetic: false, type: "onerror" },
          stacktrace: {
            type: "raw",
            frames: [
              {
                platform: "web:javascript",
                filename: "https://app.opengeni.ai/assets/index-abc123.js",
                abs_path: "https://app.opengeni.ai/assets/index-abc123.js",
                function: "Object.render",
                lineno: 12,
                colno: 3456,
                in_app: true,
                chunk_id: "chunk-1",
              },
              { platform: "web:javascript", filename: "https://app.opengeni.ai/<page>" },
            ],
          },
        },
        {
          type: "Error",
          value: REDACTED_EXCEPTION_MESSAGE,
          mechanism: { handled: true, exception_id: 1, parent_id: 0 },
        },
      ],
    });
  });

  test("drops an event without a usable exception", () => {
    expect(
      scrubPosthogExceptionProperties({ $exception_message: SECRET }, { revision: "r" }),
    ).toBeNull();
    expect(
      scrubPosthogExceptionProperties({ $exception_list: [SECRET, null] }, { revision: "r" }),
    ).toBeNull();
  });

  test("bounds exceptions and frames, keeping the frames nearest the throw", () => {
    const frames = Array.from({ length: 100 }, (_, index) => ({
      platform: "web:javascript",
      function: `f${index}`,
      lineno: index,
    }));
    const scrubbed = scrubPosthogExceptionProperties(
      {
        $exception_list: Array.from({ length: 20 }, () => ({
          type: "TypeError",
          value: SECRET,
          stacktrace: { type: "raw", frames },
        })),
      },
      { revision: "r" },
    );
    const list = scrubbed?.$exception_list as { stacktrace: { frames: { lineno: number }[] } }[];
    expect(list).toHaveLength(10);
    expect(list[0]!.stacktrace.frames).toHaveLength(64);
    expect(list[0]!.stacktrace.frames.at(-1)!.lineno).toBe(99);
  });

  test("rejects unknown levels and sources", () => {
    const scrubbed = scrubPosthogExceptionProperties(
      {
        $exception_level: SECRET,
        exception_source: SECRET,
        $exception_list: [{ type: "Error", value: SECRET }],
      },
      { revision: "r" },
    );
    expect(scrubbed).not.toHaveProperty("$exception_level");
    expect(scrubbed).not.toHaveProperty("exception_source");
  });

  test("script locations lose query, fragment, credentials and inline content", () => {
    expect(safeScriptLocation("https://user:pass@app.opengeni.ai/assets/a.js?x=1#y")).toBe(
      "https://app.opengeni.ai/assets/a.js",
    );
    expect(safeScriptLocation(`https://app.opengeni.ai/workspaces/w/sessions/s?q=${SECRET}`)).toBe(
      "https://app.opengeni.ai/<page>",
    );
    expect(safeScriptLocation(`data:text/javascript,alert("${SECRET}")`)).toBe("data:");
    expect(safeScriptLocation("blob:https://app.opengeni.ai/0f8f0e0e-uuid")).toBe(
      "blob:https://app.opengeni.ai",
    );
    expect(safeScriptLocation("chrome-extension://abcdef/content.js?x=1")).toBe(
      "chrome-extension://abcdef/content.js",
    );
    expect(safeScriptLocation("<anonymous>")).toBe("<anonymous>");
    expect(safeScriptLocation(`${SECRET} "free text"`)).toBeUndefined();
    expect(safeScriptLocation(42)).toBeUndefined();
  });

  test("exception types are constructor-like names", () => {
    expect(safeExceptionType("DOMException")).toBe("DOMException");
    expect(safeExceptionType("Error: something the person typed")).toBe("Error");
    expect(safeExceptionType(undefined)).toBe("Error");
  });

  test("reads the leading exception for drop decisions", () => {
    expect(leadingException({ $exception_list: [{ type: "TypeError", value: "x" }] })).toEqual({
      name: "TypeError",
      message: "x",
    });
    expect(leadingException({})).toBeNull();
  });
});
