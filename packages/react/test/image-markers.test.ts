import { describe, expect, test } from "bun:test";
import { messageImageIds, reconcileImageMarkers, restoredImageKey } from "../src/lib/image-markers";

describe("reconcileImageMarkers", () => {
  test("a new image gets its tag where the person was writing", () => {
    expect(
      reconcileImageMarkers({
        text: "The header is off",
        previous: [],
        next: ["a"],
        insert: ["a"],
        caret: 17,
      }),
    ).toEqual({ text: "The header is off [Image 1] ", caret: 28 });
    expect(
      reconcileImageMarkers({
        text: "Before\n\nAfter",
        previous: [],
        next: ["a"],
        insert: ["a"],
        caret: 7,
      }),
    ).toEqual({ text: "Before\n[Image 1]\nAfter", caret: 16 });
    expect(
      reconcileImageMarkers({ text: "", previous: [], next: ["a"], insert: ["a"], caret: 0 }),
    ).toEqual({ text: "[Image 1] ", caret: 10 });
  });

  test("a tag added mid-word keeps both halves and the caret after it", () => {
    expect(
      reconcileImageMarkers({ text: "abcd", previous: [], next: ["a"], insert: ["a"], caret: 2 }),
    ).toEqual({ text: "ab [Image 1] cd", caret: 13 });
  });

  test("several images added at once share one place, numbered after the earlier ones", () => {
    expect(
      reconcileImageMarkers({
        text: "One [Image 1] two ",
        previous: ["a"],
        next: ["a", "b", "c"],
        insert: ["c", "b"],
        caret: 18,
      }),
    ).toEqual({ text: "One [Image 1] two [Image 2] [Image 3] ", caret: 38 });
  });

  test("removing an image deletes its tag and renumbers the later ones", () => {
    expect(
      reconcileImageMarkers({
        text: "A [Image 1] B [Image 2] C [Image 3]",
        previous: ["a", "b", "c"],
        next: ["a", "c"],
        insert: [],
        caret: 35,
      }),
    ).toEqual({ text: "A [Image 1] B C [Image 2]", caret: 25 });
    // The first image going renumbers every later tag, wherever it was moved.
    expect(
      reconcileImageMarkers({
        text: "[Image 3] first, then [Image 1] and [Image 2]",
        previous: ["a", "b", "c"],
        next: ["b", "c"],
        insert: [],
        caret: 0,
      }),
    ).toEqual({ text: "[Image 2] first, then and [Image 1]", caret: 0 });
  });

  test("the caret keeps its place in the text around renumbered and removed tags", () => {
    const text = "x [Image 1] y [Image 2] z";
    // Caret after "y": the removed tag before it shifts it left by the tag and a space.
    expect(
      reconcileImageMarkers({ text, previous: ["a", "b"], next: ["b"], insert: [], caret: 13 }),
    ).toEqual({ text: "x y [Image 1] z", caret: 3 });
    // Caret inside a removed tag lands where the tag was.
    expect(
      reconcileImageMarkers({ text, previous: ["a", "b"], next: ["b"], insert: [], caret: 5 }),
    ).toEqual({ text: "x y [Image 1] z", caret: 2 });
  });

  test("both copies of a duplicated tag follow their image", () => {
    expect(
      reconcileImageMarkers({
        text: "[Image 2] here and [Image 2] there",
        previous: ["a", "b"],
        next: ["b"],
        insert: [],
        caret: 0,
      }),
    ).toEqual({ text: "[Image 1] here and [Image 1] there", caret: 0 });
  });

  test("hand-written, edited and unrelated tags are left alone", () => {
    expect(
      reconcileImageMarkers({
        text: "see [Image 7]",
        previous: ["a"],
        next: ["a"],
        insert: [],
        caret: 0,
      }),
    ).toBeNull();
    expect(
      reconcileImageMarkers({
        text: "see [Image 7] [Image 1]",
        previous: ["a", "b"],
        next: ["b"],
        insert: [],
        caret: 0,
      }),
    ).toEqual({ text: "see [Image 7]", caret: 0 });
    // A tag the person edited is no longer a tag; the others still renumber.
    expect(
      reconcileImageMarkers({
        text: "[Image 1 is cut] and [image 2] and [Image 3]",
        previous: ["a", "b", "c"],
        next: ["c"],
        insert: [],
        caret: 0,
      }),
    ).toEqual({ text: "[Image 1 is cut] and [image 2] and [Image 1]", caret: 0 });
  });

  test("restored images bring their tags with the restored text", () => {
    // A restored draft's images are not inserted again.
    expect(
      reconcileImageMarkers({
        text: "x [Image 1] y [Image 2]",
        previous: [],
        next: ["r1", "r2"],
        insert: [],
        caret: 0,
      }),
    ).toBeNull();
    // An image added after them is numbered after them.
    expect(
      reconcileImageMarkers({
        text: "x [Image 1] y [Image 2] and ",
        previous: ["r1", "r2"],
        next: ["r1", "r2", "c"],
        insert: ["c"],
        caret: 28,
      }),
    ).toEqual({ text: "x [Image 1] y [Image 2] and [Image 3] ", caret: 38 });
  });
});

describe("messageImageIds", () => {
  const image = (id: string, fileId?: string) => ({
    id,
    contentType: "image/png",
    ...(fileId ? { file: { id: fileId } } : {}),
  });

  test("restored images come first, then image attachments in order; other files don't count", () => {
    expect(
      messageImageIds(
        ["f1"],
        [image("a"), { id: "pdf", contentType: "application/pdf" }, image("b")],
      ),
    ).toEqual([restoredImageKey("f1"), "a", "b"]);
  });

  test("an attachment that is also a restored file is counted once, in its restored place", () => {
    expect(messageImageIds(["f1"], [image("a", "f1"), image("b")])).toEqual([
      restoredImageKey("f1"),
      "b",
    ]);
  });
});
