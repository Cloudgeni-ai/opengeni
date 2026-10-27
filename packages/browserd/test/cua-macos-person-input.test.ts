import { describe, expect, test } from "bun:test";
import {
  newestReading,
  PERSON_EVENT_TYPES,
  recentPersonInput,
} from "../src/cua/macos-person-input";

describe("macOS person input", () => {
  test("the most recent reading counts, and readings that are not a time are skipped", () => {
    expect(newestReading([90, 3.5, 12])).toBe(3.5);
    expect(newestReading([Number.NaN, -1, Number.POSITIVE_INFINITY, 7])).toBe(7);
    expect(newestReading([Number.NaN])).toBeNull();
    expect(newestReading([])).toBeNull();
  });

  test("only input within the last minute is reported, in whole seconds", () => {
    expect(recentPersonInput(0.4)).toBe(0);
    expect(recentPersonInput(59.9)).toBe(59);
    expect(recentPersonInput(60)).toBeUndefined();
    expect(recentPersonInput(null)).toBeUndefined();
  });

  test("every kind of a person's input is asked once, and only types with their own timer", () => {
    expect(new Set(PERSON_EVENT_TYPES).size).toBe(PERSON_EVENT_TYPES.length);
    for (const type of [1, 5, 10, 12, 22]) expect(PERSON_EVENT_TYPES).toContain(type);
    // A type the HID system answers with its any-event timer would count the
    // keys agents send to apps in the background.
    expect(PERSON_EVENT_TYPES.every((type) => type < 32)).toBe(true);
  });
});
