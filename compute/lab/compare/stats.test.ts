import { expect, test } from "bun:test";
import { percentile, summarize } from "./stats.ts";

const hundred = Array.from({ length: 100 }, (_, i) => i + 1);

test("nearest rank picks real samples", () => {
  expect(percentile(hundred, 50)).toBe(50);
  expect(percentile(hundred, 90)).toBe(90);
  expect(percentile(hundred, 99)).toBe(99);
  expect(percentile(hundred, 100)).toBe(100);
  expect(percentile([7], 1)).toBe(7);
});

test("with few samples the tail errs high", () => {
  const ten = Array.from({ length: 10 }, (_, i) => i + 1);
  // 99 percent of 10 samples rounds up to the 10th: the max, never an interpolation.
  expect(percentile(ten, 99)).toBe(10);
  expect(percentile(ten, 90)).toBe(9);
  expect(percentile(ten, 50)).toBe(5);
  // p99 of 90 samples is the 90th smallest.
  expect(
    percentile(
      Array.from({ length: 90 }, (_, i) => i),
      99,
    ),
  ).toBe(89);
});

test("percentiles reject nonsense", () => {
  expect(() => percentile([], 50)).toThrow();
  expect(() => percentile([1], 0)).toThrow();
  expect(() => percentile([1], 101)).toThrow();
});

test("summaries sort their input and leave it alone", () => {
  const samples = [5, 1, 4, 2, 3];
  const summary = summarize(samples);
  expect(summary).toEqual({ count: 5, p50: 3, p90: 5, p99: 5, max: 5, mean: 3 });
  expect(samples).toEqual([5, 1, 4, 2, 3]);
});
