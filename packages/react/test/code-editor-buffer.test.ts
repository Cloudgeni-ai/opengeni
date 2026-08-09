import { describe, expect, test } from "bun:test";
import { reconcileEditorBuffer, type EditorBufferState } from "../src/components/code-editor";

describe("CodeEditor buffer ownership", () => {
  const clean = (contents = "base\n"): EditorBufferState => ({
    path: "api/base.txt",
    value: contents,
    baseline: contents,
  });

  test("adopts a same-file remote refresh while clean", () => {
    expect(
      reconcileEditorBuffer(clean(), {
        path: "api/base.txt",
        contents: "remote\n",
      }),
    ).toEqual(clean("remote\n"));
  });

  test("retains a dirty buffer and its original CAS baseline across remote refreshes", () => {
    const dirty: EditorBufferState = {
      path: "api/base.txt",
      value: "base\nlocal\n",
      baseline: "base\n",
    };
    const reconciled = reconcileEditorBuffer(dirty, {
      path: "api/base.txt",
      contents: "remote\n",
    });

    expect(reconciled).toBe(dirty);
    expect(reconciled.value).toBe("base\nlocal\n");
    expect(reconciled.baseline).toBe("base\n");
  });

  test("switching files resets even a dirty buffer", () => {
    expect(
      reconcileEditorBuffer(
        {
          path: "api/base.txt",
          value: "base\nlocal\n",
          baseline: "base\n",
        },
        { path: "api/server.ts", contents: "export {};\n" },
      ),
    ).toEqual({
      path: "api/server.ts",
      value: "export {};\n",
      baseline: "export {};\n",
    });
  });

  test("returns the existing state when the clean snapshot is unchanged", () => {
    const state = clean();
    expect(reconcileEditorBuffer(state, { path: "api/base.txt", contents: "base\n" })).toBe(state);
  });
});
