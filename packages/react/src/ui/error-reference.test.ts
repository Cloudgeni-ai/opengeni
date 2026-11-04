import { describe, expect, test } from "bun:test";

import { apiStatusInText, isExpectedApiStatus, splitErrorText } from "./error-reference";

const REFERENCE = "163bc913-264d-4d38-a0b5-2e4e955eecdb";

describe("error text and its reference", () => {
  test("a raw expected refusal loses its status prefix and its reference", () => {
    expect(
      splitErrorText(
        `API 409: This chat can't be archived. "Keep this chat active" is on. Reference: ${REFERENCE}.`,
      ),
    ).toEqual({
      text: `This chat can't be archived. "Keep this chat active" is on.`,
      reference: undefined,
    });
    expect(splitErrorText(`Opengeni API 403: missing permission Reference: ${REFERENCE}.`)).toEqual(
      { text: "missing permission", reference: undefined },
    );
    // After the caller's own sentence too.
    expect(splitErrorText(`Couldn't save. API 422: name is required Reference: req-1.`)).toEqual({
      text: "Couldn't save. name is required",
      reference: undefined,
    });
  });

  test("an unexpected failure keeps its reference apart from the text", () => {
    expect(
      splitErrorText(
        `Opengeni couldn't finish the request. Try again in a moment. Reference: ${REFERENCE}.`,
      ),
    ).toEqual({
      text: "Opengeni couldn't finish the request. Try again in a moment.",
      reference: REFERENCE,
    });
    expect(splitErrorText(`API 500: database unavailable Reference: req-skills-list.`)).toEqual({
      text: "database unavailable",
      reference: "req-skills-list",
    });
  });

  test("text without either is unchanged", () => {
    for (const text of ["Pick a workspace first.", "Your API key is invalid.", ""]) {
      expect(splitErrorText(text)).toEqual({ text, reference: undefined });
    }
  });

  test("only a 4xx is an expected refusal", () => {
    expect([400, 404, 409, 429, 499].every(isExpectedApiStatus)).toBe(true);
    expect([undefined, 0, 302, 500, 503].some(isExpectedApiStatus)).toBe(false);
    expect(apiStatusInText("Opengeni API 404: gone")).toBe(404);
    expect(apiStatusInText("Pick a workspace first.")).toBeUndefined();
  });
});
