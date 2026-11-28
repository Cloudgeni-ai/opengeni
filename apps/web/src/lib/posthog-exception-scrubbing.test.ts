import { describe, expect, test } from "bun:test";

import {
  EXTERNAL_LOCATION,
  REDACTED_EXCEPTION_MESSAGE,
  leadingException,
  safeExceptionType,
  safeScriptLocation,
  scrubPosthogExceptionProperties,
} from "./posthog-exception-scrubbing";

// Every value a customer could have typed or seen carries this marker, so a
// single search of the serialized result proves none of it survives.
const SECRET = "customer-secret-7f3a";
const ORIGIN = "https://app.opengeni.ai";
const context = { revision: "rev-1", pageOrigin: ORIGIN };

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
              filename: `${ORIGIN}/assets/index-abc123.js?token=${SECRET}#${SECRET}`,
              abs_path: `${ORIGIN}/assets/index-abc123.js?token=${SECRET}`,
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
              filename: `${ORIGIN}/share/${SECRET}`,
              lineno: 3,
              colno: 7,
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
    const scrubbed = scrubPosthogExceptionProperties(exceptionEvent(), context);
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
                filename: `${ORIGIN}/assets/index-abc123.js`,
                abs_path: `${ORIGIN}/assets/index-abc123.js`,
                function: "Object.render",
                lineno: 12,
                colno: 3456,
                in_app: true,
                chunk_id: "chunk-1",
              },
              { platform: "web:javascript", filename: `${ORIGIN}/<page>`, lineno: 3, colno: 7 },
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

  test("drops frames the SDK parsed out of a multi-line message", () => {
    // Chrome renders `${name}: ${message}\n    at …`; the SDK's parser skips
    // only the first line, so message lines 2+ come back as frames. These are
    // the shapes it produces for them, then two engine-rendered frames.
    const scrubbed = scrubPosthogExceptionProperties(
      {
        $exception_list: [
          {
            type: "Error",
            value: `Request failed\n${SECRET} plan for acme at https://acme.example/x.js:1:2`,
            stacktrace: {
              type: "raw",
              frames: [
                {
                  platform: "web:javascript",
                  function: `${SECRET} plan for acme at `,
                  filename: "https://acme.example/x.js",
                  lineno: 1,
                  colno: 2,
                },
                {
                  platform: "web:javascript",
                  function: `${SECRET} two words`,
                  filename: "<anonymous>",
                  lineno: 1,
                },
                // `at acme` alone parses as a location without a line.
                { platform: "web:javascript", filename: SECRET },
                { platform: "web:javascript", filename: SECRET, lineno: 4 },
                // A host a message named, without a function: kept, but only as external.
                {
                  platform: "web:javascript",
                  filename: `https://${SECRET}.example/a.js`,
                  lineno: 9,
                },
                // Any scheme but a browser extension's is quoted text too.
                {
                  platform: "web:javascript",
                  function: "?",
                  filename: `foo://${SECRET}.example/a.js`,
                  lineno: 1,
                  colno: 1,
                },
                { platform: "web:javascript", function: "JSON.parse", filename: "<anonymous>" },
                {
                  platform: "web:javascript",
                  function: "async Promise.all",
                  filename: "<anonymous>",
                  lineno: 1,
                  colno: 1,
                },
                {
                  platform: "web:javascript",
                  function: "Object.<anonymous> [as handle]",
                  filename: `${ORIGIN}/assets/app-1.js`,
                  lineno: 20,
                  colno: 4,
                },
              ],
            },
          },
        ],
      },
      context,
    );
    expect(JSON.stringify(scrubbed)).not.toContain(SECRET);
    expect(JSON.stringify(scrubbed)).not.toContain("acme");
    const list = scrubbed!.$exception_list as { stacktrace: unknown }[];
    expect(list[0]!.stacktrace).toEqual({
      type: "raw",
      frames: [
        { platform: "web:javascript", filename: EXTERNAL_LOCATION, lineno: 9 },
        {
          platform: "web:javascript",
          function: "async Promise.all",
          filename: "<anonymous>",
          lineno: 1,
          colno: 1,
        },
        {
          platform: "web:javascript",
          function: "Object.<anonymous> [as handle]",
          filename: `${ORIGIN}/assets/app-1.js`,
          lineno: 20,
          colno: 4,
        },
      ],
    });
  });

  test("keeps anonymous frames, which the SDK names `?`", () => {
    // Chrome `at https://…/index-a.js:1:200` and Safari `@https://…` frames:
    // minified bundles are mostly anonymous functions, including the throw site.
    const anonymous = [
      {
        platform: "web:javascript",
        function: "?",
        filename: `${ORIGIN}/assets/vendor-b.js`,
        lineno: 2,
        colno: 10,
        in_app: true,
      },
      {
        platform: "web:javascript",
        function: "?",
        filename: `${ORIGIN}/assets/index-a.js`,
        lineno: 1,
        colno: 200,
        in_app: true,
      },
    ];
    const scrubbed = scrubPosthogExceptionProperties(
      {
        $exception_list: [
          { type: "TypeError", value: SECRET, stacktrace: { type: "raw", frames: anonymous } },
        ],
      },
      context,
    );
    const list = scrubbed?.$exception_list as { stacktrace: { frames: unknown[] } }[];
    expect(list[0]!.stacktrace.frames).toEqual(anonymous);
  });

  test("drops an event without a usable exception", () => {
    expect(scrubPosthogExceptionProperties({ $exception_message: SECRET }, context)).toBeNull();
    expect(
      scrubPosthogExceptionProperties({ $exception_list: [SECRET, null] }, context),
    ).toBeNull();
  });

  test("bounds exceptions and frames, keeping the frames nearest the throw", () => {
    const frames = Array.from({ length: 100 }, (_, index) => ({
      platform: "web:javascript",
      function: `f${index}`,
      filename: `${ORIGIN}/assets/a.js`,
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
      context,
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
      context,
    );
    expect(scrubbed).not.toHaveProperty("$exception_level");
    expect(scrubbed).not.toHaveProperty("exception_source");
  });

  test("script locations lose query, fragment, credentials, other hosts and inline content", () => {
    const location = (value: unknown) => safeScriptLocation(value, ORIGIN);
    expect(location(`https://user:pass@app.opengeni.ai/assets/a.js?x=1#y`)).toBe(
      `${ORIGIN}/assets/a.js`,
    );
    expect(location(`${ORIGIN}/workspaces/w/sessions/s?q=${SECRET}`)).toBe(`${ORIGIN}/<page>`);
    expect(location("https://www.googletagmanager.com/gtag/js?id=G-1")).toBe(EXTERNAL_LOCATION);
    expect(location(`data:text/javascript,alert("${SECRET}")`)).toBe("data:");
    expect(location(`blob:${ORIGIN}/0f8f0e0e-uuid`)).toBe("blob:");
    expect(location("chrome-extension://abcdef/content.js?x=1")).toBe(
      "chrome-extension://abcdef/content.js",
    );
    expect(location("webkit-masked-url://hidden/")).toBe("webkit-masked-url://hidden");
    expect(location(`foo://${SECRET}/a.js`)).toBeUndefined();
    expect(location("<anonymous>")).toBe("<anonymous>");
    expect(location("native")).toBe("native");
    expect(location(SECRET)).toBeUndefined();
    expect(location(`${SECRET} "free text"`)).toBeUndefined();
    expect(location(42)).toBeUndefined();
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
