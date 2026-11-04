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

  test("Add credits beside an own-key refusal opens a top-up that knows it", async () => {
    const session = await source("routes/session.tsx");
    expect(session).toContain("refusalCode={topupRefusal}");
    expect(session).toMatch(/stopRefusal\) ===\s*"byok_paid_credit_required"/);
    const index = await source("routes/sessions-index.tsx");
    expect(index).toMatch(
      /purpose="topup"\s*refusalCode=\{\s*refusedCreate\?\.code === "byok_paid_credit_required"/,
    );
  });

  test("the composer and the plain failure line know who is viewing", async () => {
    const session = await source("routes/session.tsx");
    expect(session).toMatch(/useComposer\(props\.session\.id, \{\s*canBuyCredits,/);
    expect(session).toMatch(/failureFallbackReason\([\s\S]*?stopRefusal,\s*\),\s*canBuyCredits,/);
  });

  test("the fallback credits dialog keeps the refusal code", async () => {
    expect(await source("app-state.tsx")).toContain("code: paymentRefusalCode(problem),");
    expect(await source("components/credit-required-gate.tsx")).toContain(
      "refusalCode={creditRequired.code ?? null}",
    );
  });

  test("a stopped chat's composer names the refusal's fix, never another model", async () => {
    const session = await source("routes/session.tsx");
    // The refusal comes from the last turn end, so a stop between model calls names it too.
    expect(session).toContain("useMemo(() => creditRefusalFromEvents(events), [events])");
    expect(session).toContain("creditRefusal={creditRefusal}");
    expect(session).toContain(
      "const stopRefusal = props.creditExhausted ? props.creditRefusal : null;",
    );
    expect(session).toContain("creditRefusal={stopRefusal}");
    expect(session).toMatch(/const creditGap =\s*props\.creditExhausted && !stopRefusal/);
    // chatComposerPlaceholder's own tests cover what each state reads.
    expect(session).toMatch(
      /placeholder=\{chatComposerPlaceholder\(\{[^}]*stopRefusal,\s*creditGap,\s*canBuyCredits,\s*\}\)\}/,
    );
  });
});
