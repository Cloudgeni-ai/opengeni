import { expect, test } from "bun:test";
import {
  CreditDebitAttribution,
  creditDebitAttributionMetadata,
  currentCreditDebitAttribution,
  withCreditDebitAttribution,
} from "../src/credit-debit-attribution";

test("frozen debit metadata keeps exact turn/human and explicit service causality", () => {
  const turnId = crypto.randomUUID();
  expect(
    creditDebitAttributionMetadata({
      kind: "turn",
      turnId,
      initiatingHumanSubjectId: "human:root",
    }),
  ).toEqual({ turnId, initiatingHumanSubjectId: "human:root" });
  expect(
    creditDebitAttributionMetadata({
      kind: "turn",
      turnId,
      initiatingHumanSubjectId: null,
    }),
  ).toEqual({ turnId });
  expect(
    creditDebitAttributionMetadata({
      kind: "human",
      initiatingHumanSubjectId: "human:upload",
    }),
  ).toEqual({ initiatingHumanSubjectId: "human:upload" });
  expect(creditDebitAttributionMetadata({ kind: "service" })).toEqual({});
  expect(() => creditDebitAttributionMetadata({ kind: "unknown" })).toThrow("no frozen");
});

test("concurrent request scopes keep immutable initiating attribution", async () => {
  await Promise.all(
    ["human:first", "human:second"].map((subject) =>
      withCreditDebitAttribution({ kind: "human", initiatingHumanSubjectId: subject }, async () => {
        await Promise.resolve();
        expect(currentCreditDebitAttribution()).toEqual({
          kind: "human",
          initiatingHumanSubjectId: subject,
        });
        expect(Object.isFrozen(currentCreditDebitAttribution())).toBe(true);
      }),
    ),
  );
  expect(currentCreditDebitAttribution()).toEqual({ kind: "unknown" });
});

test("attribution schema refuses incomplete turn/human evidence", () => {
  expect(
    CreditDebitAttribution.safeParse({ kind: "turn", turnId: crypto.randomUUID() }).success,
  ).toBe(false);
  expect(
    CreditDebitAttribution.safeParse({ kind: "human", initiatingHumanSubjectId: "" }).success,
  ).toBe(false);
  expect(CreditDebitAttribution.safeParse({ kind: "service" }).success).toBe(true);
});
