import { describe, expect, test } from "bun:test";
import { reconcileImageMarkers } from "../src/lib/image-markers";

describe("reconcileImageMarkers", () => {
  test("a new image gets its tag where the person was writing", () => {
    expect(reconcileImageMarkers("The header is off", [], ["a"], 17)).toEqual({
      text: "The header is off [Image 1] ",
      caret: 28,
    });
    expect(reconcileImageMarkers("Before\n\nAfter", [], ["a"], 7)).toEqual({
      text: "Before\n[Image 1]\nAfter",
      caret: 16,
    });
  });

  test("several images added at once share one place, numbered after the earlier ones", () => {
    expect(reconcileImageMarkers("One [Image 1] two ", ["a"], ["a", "b", "c"], 18)).toEqual({
      text: "One [Image 1] two [Image 2] [Image 3] ",
      caret: 38,
    });
  });

  test("removing an image deletes its tag and renumbers the later ones", () => {
    expect(
      reconcileImageMarkers("A [Image 1] B [Image 2] C [Image 3]", ["a", "b", "c"], ["a", "c"], 35),
    ).toEqual({ text: "A [Image 1] B C [Image 2]", caret: 25 });
  });

  test("hand-written tags and unchanged lists are left alone", () => {
    // A restored draft's images come back after its text, which has their tags.
    expect(reconcileImageMarkers("x [Image 1] y [Image 2]", [], ["r1", "r2"], 0)).toBeNull();
    expect(reconcileImageMarkers("see [Image 7]", ["a"], ["a"], 0)).toBeNull();
    expect(reconcileImageMarkers("see [Image 7] [Image 1]", ["a", "b"], ["b"], 0)).toEqual({
      text: "see [Image 7]",
      caret: 0,
    });
  });
});
