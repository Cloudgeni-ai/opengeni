import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Options = {
  description?: unknown;
  action?: { label: string; onClick: () => void };
  cancel?: { label: string; onClick: () => void };
  classNames?: Record<string, string>;
};
type Shown = { kind: string; title: unknown; options: Options | undefined };
const shown: Shown[] = [];
const record =
  (kind: string) =>
  (title: unknown, options?: Options): number => {
    shown.push({ kind, title, options });
    return shown.length;
  };
mock.module("sonner", () => ({
  toast: Object.assign(record("plain"), {
    success: record("success"),
    error: record("error"),
    info: record("info"),
    warning: record("warning"),
    loading: record("loading"),
    custom: record("custom"),
    dismiss: () => {},
  }),
}));

const { toast } = await import("./toast");

const REFERENCE = "163bc913-264d-4d38-a0b5-2e4e955eecdb";

beforeEach(() => {
  shown.length = 0;
});

describe("error toasts", () => {
  test("an expected refusal shows only the human message", () => {
    // The toast Bendik saw: the raw API message as the description.
    toast.error("Couldn't archive the chat.", {
      description: `API 409: This chat can't be archived. "Keep this chat active" is on. Turn it off in the chat's Agent tab first. Reference: ${REFERENCE}.`,
    });
    expect(shown).toEqual([
      {
        kind: "error",
        title: "Couldn't archive the chat.",
        options: {
          description: `This chat can't be archived. "Keep this chat active" is on. Turn it off in the chat's Agent tab first.`,
        },
      },
    ]);
  });

  test("an unexpected failure offers its reference behind a quiet Copy details", async () => {
    const writes: string[] = [];
    const clipboard = { writeText: async (text: string) => void writes.push(text) };
    const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: { clipboard }, configurable: true });
    try {
      toast.error("Couldn't archive the chat.", {
        description: `Opengeni couldn't finish the request. Try again in a moment. Reference: ${REFERENCE}.`,
      });
      const [first] = shown;
      expect(first!.options?.description).toBe(
        "Opengeni couldn't finish the request. Try again in a moment.",
      );
      expect(JSON.stringify(first)).not.toContain(`Reference: ${REFERENCE}.`);
      expect(first!.options?.action?.label).toBe("Copy details");
      // Quiet text, not the toast's call to action.
      expect(first!.options?.classNames).toEqual({ actionButton: "og-toast-details" });
      first!.options!.action!.onClick();
      await Promise.resolve();
      await Promise.resolve();
      expect(writes).toEqual([
        `Couldn't archive the chat.\nOpengeni couldn't finish the request. Try again in a moment.\nReference: ${REFERENCE}`,
      ]);
      expect(shown.at(-1)).toMatchObject({ kind: "success", title: "Details copied." });
    } finally {
      if (previous) Object.defineProperty(globalThis, "navigator", previous);
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
  });

  test("a caller's own action stays; Copy details takes the second button", () => {
    const retry = { label: "Retry", onClick: () => {} };
    toast.error("Couldn't load.", {
      description: `Opengeni couldn't finish the request. Reference: ${REFERENCE}.`,
      action: retry,
    });
    expect(shown[0]!.options?.action).toBe(retry);
    expect(shown[0]!.options?.cancel?.label).toBe("Copy details");
    expect(shown[0]!.options?.classNames).toEqual({ cancelButton: "og-toast-details" });
  });

  test("a message used as the title is cleaned the same way", () => {
    toast.error(`API 403: You don't have permission to do that. Reference: ${REFERENCE}.`);
    expect(shown[0]).toMatchObject({ title: "You don't have permission to do that." });
    expect(shown[0]!.options?.action).toBeUndefined();
  });

  test("ordinary toasts pass through untouched", () => {
    const options = { description: "In a few seconds it moves to long-term storage." };
    toast("Archived “Plan”", options);
    toast.success("Saved.");
    expect(shown).toEqual([
      { kind: "plain", title: "Archived “Plan”", options },
      { kind: "success", title: "Saved.", options: undefined },
    ]);
  });
});

// A toast's text comes from userErrorText (or another product sentence), never
// from an error's raw message: that is "API 409: ... Reference: <id>." for an
// API error.
const RAW_ERROR_TEXT =
  /\berrorMessage\(|\b(?:error|err|e|cause|caught|reason|failure|\w+Error)\.message\b|String\((?:error|err|e|cause|caught|reason|\w+Error)\)|\$\{(?:error|err|e|cause|caught|\w+Error)\}|\bAPI \d{3}:/u;

/** The text of a call's parenthesised arguments, from its opening parenthesis. */
function callArguments(source: string, open: number): string {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")" && --depth === 0) return source.slice(open, index + 1);
  }
  return source.slice(open);
}

function rawErrorToasts(file: string, source: string): string[] {
  const found: string[] = [];
  for (const call of source.matchAll(/\btoast(?:\.(?:error|warning|info|message|success))?\(/gu)) {
    const args = callArguments(source, call.index + call[0].length - 1);
    if (RAW_ERROR_TEXT.test(args)) {
      found.push(`${file}:${source.slice(0, call.index).split("\n").length}`);
    }
  }
  return found;
}

describe("app toasts never show raw error text", () => {
  test("the guard catches a raw error message or status prefix", () => {
    expect(
      rawErrorToasts(
        "a.tsx",
        'toast.error("Couldn\'t save.", { description: errorMessage(error) });',
      ),
    ).toEqual(["a.tsx:1"]);
    expect(
      rawErrorToasts("b.tsx", "\n toast.error(caught instanceof Error ? caught.message : 'x')"),
    ).toEqual(["b.tsx:2"]);
    expect(rawErrorToasts("c.tsx", "toast.error(`API 409: ${text}`)")).toEqual(["c.tsx:1"]);
    expect(
      rawErrorToasts(
        "d.tsx",
        'toast.error("Couldn\'t save.", { description: userErrorText(error) });',
      ),
    ).toEqual([]);
  });

  test("no web or session UI toast shows an error's raw message", async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
    const offenders: string[] = [];
    for (const dir of ["apps/web/src", "packages/react/src"]) {
      const files = await readdir(path.join(root, dir), { recursive: true });
      for (const file of files) {
        if (!/\.(?:ts|tsx)$/u.test(file) || /\.test\.tsx?$|fixture/u.test(file)) continue;
        const source = await readFile(path.join(root, dir, file), "utf8");
        offenders.push(...rawErrorToasts(path.join(dir, file), source));
      }
    }
    expect(offenders).toEqual([]);
  });
});
