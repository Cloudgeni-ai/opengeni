import { describe, expect, test } from "bun:test";
import {
  McpElicitationApprovalRequest,
  mcpElicitationChoices,
  mcpElicitationDefaults,
  mcpElicitationKind,
  mcpElicitationNeedsInput,
  mcpElicitationUrlHost,
  resolveMcpElicitationContent,
  type McpElicitationRequestedSchema,
  type McpElicitationValue,
} from "../src/index";

const details: McpElicitationRequestedSchema = {
  type: "object",
  properties: {
    room: {
      type: "string",
      title: "Room",
      oneOf: [
        { const: "small", title: "Small room" },
        { const: "large", title: "Large room" },
      ],
      default: "small",
    },
    attendees: { type: "integer", title: "People", minimum: 1, maximum: 20 },
    note: { type: "string", title: "Note", maxLength: 5 },
    email: { type: "string", format: "email" },
    day: { type: "string", format: "date" },
    when: { type: "string", format: "date-time" },
    link: { type: "string", format: "uri" },
    remind: { type: "boolean", default: false },
    tags: {
      type: "array",
      items: { type: "string", enum: ["a", "b", "c"] },
      maxItems: 2,
    },
    legacy: { type: "string", enum: ["x", "y"], enumNames: ["Ex", "Why"] },
  },
  required: ["room", "attendees"],
};

function request(...schemas: McpElicitationRequestedSchema[]): McpElicitationApprovalRequest {
  return McpElicitationApprovalRequest.parse({
    server: "Calendar",
    requests: schemas.map((requestedSchema, index) => ({
      id: `q${index + 1}`,
      message: "Question",
      requestedSchema,
    })),
  });
}

const confirm: McpElicitationRequestedSchema = { type: "object", properties: {} };

describe("MCP elicitation forms", () => {
  test("defaults and choices come from the server's schema", () => {
    expect(mcpElicitationDefaults(details)).toEqual({ room: "small", remind: false });
    expect(mcpElicitationNeedsInput(details)).toBe(true);
    expect(mcpElicitationNeedsInput(confirm)).toBe(false);
    expect(mcpElicitationChoices(details.properties.room!)).toEqual([
      { value: "small", label: "Small room" },
      { value: "large", label: "Large room" },
    ]);
    expect(mcpElicitationChoices(details.properties.legacy!)).toEqual([
      { value: "x", label: "Ex" },
      { value: "y", label: "Why" },
    ]);
    expect(mcpElicitationChoices(details.properties.attendees!)).toBeNull();
  });

  test("the request schema rejects required fields the form does not define", () => {
    const parsed = McpElicitationApprovalRequest.safeParse({
      server: "Calendar",
      requests: [
        {
          id: "q1",
          message: "?",
          requestedSchema: { type: "object", properties: {}, required: ["missing"] },
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  test("a plain approval answers a confirmation, and defaults fill the answer", () => {
    expect(resolveMcpElicitationContent(request(confirm), undefined)).toEqual({
      ok: true,
      content: { q1: {} },
    });
    expect(
      resolveMcpElicitationContent(request(details, confirm), { q1: { attendees: 3 } }),
    ).toEqual({
      ok: true,
      content: { q1: { room: "small", remind: false, attendees: 3 }, q2: {} },
    });
  });

  test("a required field without a default must be answered", () => {
    expect(resolveMcpElicitationContent(request(details), undefined)).toEqual({
      ok: false,
      problem: "People is required",
    });
  });

  test("answers to unknown questions or fields are refused", () => {
    expect(resolveMcpElicitationContent(request(confirm), { q9: {} })).toEqual({
      ok: false,
      problem: "There is no question q9 to answer",
    });
    expect(resolveMcpElicitationContent(request(confirm), { q1: { extra: "x" } })).toEqual({
      ok: false,
      problem: "The form has no field extra",
    });
  });

  const refused: Array<[Record<string, McpElicitationValue>, string]> = [
    [{ attendees: "3" }, "People must be a number"],
    [{ attendees: 2.5 }, "People must be a whole number"],
    [{ attendees: 0 }, "People must be at least 1"],
    [{ attendees: 21 }, "People must be at most 20"],
    [{ attendees: 2, room: "medium" }, "Room must be one of the offered choices"],
    [{ attendees: 2, note: "too long" }, "Note must be at most 5 characters"],
    [{ attendees: 2, email: "nope" }, "email must be an email address"],
    [{ attendees: 2, day: "2026-02-30" }, "day must be a date (YYYY-MM-DD)"],
    [{ attendees: 2, when: "tomorrow" }, "when must be a date and time"],
    [{ attendees: 2, link: "not a url" }, "link must be a URL"],
    [{ attendees: 2, remind: "yes" }, "remind must be true or false"],
    [{ attendees: 2, tags: ["a", "z"] }, "tags must only contain offered choices"],
    [{ attendees: 2, tags: ["a", "b", "c"] }, "tags must have at most 2 choices"],
    [{ attendees: 2, legacy: "z" }, "legacy must be one of the offered choices"],
  ];
  test.each(refused)("refuses %j", (answer, problem) => {
    expect(resolveMcpElicitationContent(request(details), { q1: answer })).toEqual({
      ok: false,
      problem,
    });
  });

  test("accepts a complete, valid answer as given", () => {
    const answer = {
      attendees: 20,
      room: "large",
      note: "hi",
      email: "a@example.com",
      day: "2026-02-28",
      when: "2026-02-28T10:00:00.000Z",
      link: "https://example.com",
      remind: true,
      tags: ["a", "c"],
      legacy: "y",
    };
    expect(resolveMcpElicitationContent(request(details), { q1: answer })).toEqual({
      ok: true,
      content: { q1: answer },
    });
  });
});

describe("MCP elicitation pages to open", () => {
  const signIn = (url: string) =>
    McpElicitationApprovalRequest.safeParse({
      server: "Accounts",
      requests: [{ id: "signIn", mode: "url", message: "Sign in to continue.", url }],
    });

  test("only plain https links are offered, shown by their exact host", () => {
    expect(signIn("https://accounts.example.com/sign-in?next=%2F").success).toBe(true);
    expect(mcpElicitationUrlHost("https://accounts.example.com/sign-in")).toBe(
      "accounts.example.com",
    );
    // The host a link really leads to, never what its text suggests.
    expect(mcpElicitationUrlHost("https://bank.example@evil.example/")).toBeNull();
    expect(mcpElicitationUrlHost("https://xn--bnk-sna.example/")).toBe("xn--bnk-sna.example");
    for (const unsafe of [
      "http://accounts.example.com/",
      "javascript:alert(1)",
      "data:text/html,hi",
      "https://user:secret@accounts.example.com/",
      "accounts.example.com",
    ]) {
      expect(mcpElicitationUrlHost(unsafe)).toBeNull();
      expect(signIn(unsafe).success).toBe(false);
    }
  });

  test("a page takes no answer beyond the approval", () => {
    const parsed = signIn("https://accounts.example.com/sign-in");
    if (!parsed.success) throw parsed.error;
    expect(resolveMcpElicitationContent(parsed.data, undefined)).toEqual({ ok: true, content: {} });
    expect(resolveMcpElicitationContent(parsed.data, { signIn: {} })).toEqual({
      ok: true,
      content: {},
    });
    expect(resolveMcpElicitationContent(parsed.data, { signIn: { code: "1" } })).toEqual({
      ok: false,
      problem: "Question signIn has nothing to fill in",
    });
  });

  test("the kind of question says how the person answers it", () => {
    expect(mcpElicitationKind(request(confirm))).toBe("confirm");
    expect(mcpElicitationKind(request(confirm, details))).toBe("form");
    const page = signIn("https://accounts.example.com/sign-in");
    if (!page.success) throw page.error;
    expect(mcpElicitationKind(page.data)).toBe("url");
    expect(
      mcpElicitationKind({
        server: "Accounts",
        requests: [...request(confirm).requests, ...page.data.requests],
      }),
    ).toBe("url");
    // Fields outrank a page: the form's card shows both.
    expect(
      mcpElicitationKind({
        server: "Accounts",
        requests: [...request(details).requests, ...page.data.requests],
      }),
    ).toBe("form");
  });
});
