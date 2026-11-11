import { expect, test } from "bun:test";
import { answerReadingOffset } from "../src/timeline/reading-position";

test("a growing or completed long answer stays at its beginning", () => {
  const input = { viewportHeight: 600, prompt: { top: 800, bottom: 900 }, followTail: false };
  expect(answerReadingOffset({ ...input, contentHeight: 1100 })).toBe(500);
  expect(answerReadingOffset({ ...input, contentHeight: 1600 })).toBe(788);
  expect(answerReadingOffset({ ...input, contentHeight: 3000 })).toBe(788);
});

test("long attachments leave most of the viewport for the answer", () => {
  expect(
    answerReadingOffset({
      contentHeight: 3000,
      viewportHeight: 600,
      prompt: { top: 100, bottom: 1000 },
      followTail: false,
    }),
  ).toBe(778);
});

test("explicit jump to latest and short content retain their natural offsets", () => {
  expect(
    answerReadingOffset({
      contentHeight: 3000,
      viewportHeight: 600,
      prompt: { top: 800, bottom: 900 },
      followTail: true,
    }),
  ).toBe(2400);
  expect(
    answerReadingOffset({
      contentHeight: 300,
      viewportHeight: 600,
      prompt: { top: 10, bottom: 100 },
      followTail: false,
    }),
  ).toBe(0);
});
