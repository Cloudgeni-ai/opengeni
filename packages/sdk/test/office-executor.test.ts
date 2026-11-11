import { describe, expect, test } from "bun:test";
import { explainOfficeError, runOfficeCode, serialQueue } from "../src/office/executor";

// A stand-in for an Office proxy: `format.fill` is a getter-only object.
class Fill {
  color = "";
}
class Format {
  #fill = new Fill();
  get fill() {
    return this.#fill;
  }
}
const fakeRun = async (batch: (context: unknown) => Promise<unknown>) =>
  batch({ range: { format: new Format() } });

describe("runOfficeCode", () => {
  test("returns the JSON-safe value and console output", async () => {
    const result = await runOfficeCode(
      'console.log("hi", { a: 1 }); console.warn("careful"); return { n: 2, at: undefined };',
      fakeRun,
      {},
    );
    expect(result).toMatchObject({
      ok: true,
      value: { n: 2 },
      logs: ['hi {"a":1}', "warn: careful"],
    });
  });

  test("assigning a value to an Office object fails instead of doing nothing", async () => {
    const result = await runOfficeCode('context.range.format.fill = "#DCEAF7";', fakeRun, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(
      /^Cannot assign to .*: it is an Office\.js object, not a value\./,
    );
  });

  test("names the property in Chromium's wording and still explains Safari's", () => {
    expect(explainOfficeError("Cannot set property fill of #<n> which has only a getter")).toBe(
      'Cannot assign to "fill": it is an Office.js object, not a value. Set one of its properties instead (for example range.format.fill.color).',
    );
    expect(explainOfficeError("Attempted to assign to readonly property.")).toMatch(
      /^Cannot assign to this property: it is an Office\.js object/,
    );
    expect(explainOfficeError("The argument is invalid.")).toBe("The argument is invalid.");
  });

  test("setting the object's own property works", async () => {
    const result = await runOfficeCode(
      'context.range.format.fill.color = "#DCEAF7"; return context.range.format.fill.color;',
      fakeRun,
      {},
    );
    expect(result).toMatchObject({ ok: true, value: "#DCEAF7" });
  });

  test("an undeclared variable is an error, not a global", async () => {
    const result = await runOfficeCode("leaked = 1; return leaked;", fakeRun, {});
    expect(result.ok).toBe(false);
    expect((globalThis as { leaked?: unknown }).leaked).toBeUndefined();
  });

  test("Office errors keep their code, location and statement", async () => {
    const result = await runOfficeCode(
      'throw Object.assign(new Error("The argument is invalid."), { name: "RichApi.Error", code: "InvalidArgument", debugInfo: { errorLocation: "Range.values", statement: "range.values = ...;" } });',
      fakeRun,
      {},
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        name: "RichApi.Error",
        code: "InvalidArgument",
        message: "The argument is invalid.",
        location: "Range.values",
        statement: "range.values = ...;",
      },
    });
  });
});

describe("serialQueue", () => {
  test("runs tasks one at a time in order, past failures", async () => {
    const queue = serialQueue();
    const order: string[] = [];
    const slow = queue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("a");
      throw new Error("a failed");
    });
    const fast = queue(async () => {
      order.push("b");
      return "b";
    });
    await expect(slow).rejects.toThrow("a failed");
    expect(await fast).toBe("b");
    expect(order).toEqual(["a", "b"]);
  });
});
