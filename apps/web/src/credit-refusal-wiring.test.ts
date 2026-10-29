import { describe, expect, test } from "bun:test";

async function source(path: string): Promise<string> {
  return Bun.file(`${import.meta.dir}/../../../packages/react/src/app/${path}`).text();
}

// Own-key and API refusals name one fix (Upgrade to Pro or Add credits). The
// notice and dialog are tested on their own; these pin the routes that hand
// them the refusal's code, so a dropped prop can't fall back to generic copy.
describe("credit refusal wiring", () => {
  test("a refused Send passes its refusal code to the chat notice", async () => {
    const session = await source("routes/session.tsx");
    expect(session).toContain("creditRefusalRecord(");
    expect(session).toContain("refusalCode={sessionCreditRefusal.code}");
    const index = await source("routes/sessions-index.tsx");
    expect(index).toContain("creditRefusalRecord(");
    expect(index).toContain("refusalCode={refusedCreate?.code}");
  });

  test("the fallback credits dialog keeps the refusal code", async () => {
    expect(await source("app-state.tsx")).toContain("code: paymentRefusalCode(problem),");
    expect(await source("components/credit-required-gate.tsx")).toContain(
      "refusalCode={creditRequired.code ?? null}",
    );
  });

  test("a stopped chat's composer names the refusal's fix, never another model", async () => {
    const session = await source("routes/session.tsx");
    expect(session).toContain(
      "creditRefusalKindFromText(props.failure?.recordedDetail, props.failure?.reason)",
    );
    expect(session).toMatch(/const creditGap =\s*props\.creditExhausted && !stopRefusal/);
    expect(session).toMatch(
      /stopRefusal\s*\?\s*creditRefusalHeadline\(t, stopRefusal\)\s*:\s*creditGap/,
    );
  });
});
