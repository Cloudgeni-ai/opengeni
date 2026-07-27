import { describe, expect, test } from "bun:test";
import {
  exactHeadReleaseReview,
  exactHeadReleaseReviewSha256,
  formatExactHeadReleaseReview,
} from "./release-review";

const base = "1".repeat(40);
const head = "2".repeat(40);

describe("exact-head release review formatter", () => {
  test("emits one closed, provider-independent PASS artifact", () => {
    const review = exactHeadReleaseReview({
      reviewedBaseSha: base,
      reviewedHeadSha: head,
      reviewerLogin: "release-maintainer",
    });

    expect(review).toEqual({
      version: 3,
      kind: "opengeni-exact-head-release-review",
      repository: "Cloudgeni-ai/opengeni",
      reviewedBaseSha: base,
      reviewedHeadSha: head,
      reviewerLogin: "release-maintainer",
      reviewProfile: "exact-head-maintainer-v1",
      verdict: "PASS",
    });
    expect(formatExactHeadReleaseReview(review)).toBe(
      `<!-- opengeni-exact-head-release-review:v3 -->\n\n\`\`\`json\n${JSON.stringify(review, null, 2)}\n\`\`\``,
    );
    expect(exactHeadReleaseReviewSha256(review)).toBe(
      "5ddaa413ac98b2782e4b86b9b324816bb247dbbb8e5d4288f97131a350f50a45",
    );
  });

  test("rejects mutable or ambiguous review identity", () => {
    expect(() =>
      exactHeadReleaseReview({
        reviewedBaseSha: "ABC",
        reviewedHeadSha: head,
        reviewerLogin: "release-maintainer",
      }),
    ).toThrow("reviewed base");
    expect(() =>
      exactHeadReleaseReview({
        reviewedBaseSha: base,
        reviewedHeadSha: base,
        reviewerLogin: "release-maintainer",
      }),
    ).toThrow("must differ");
    expect(() =>
      exactHeadReleaseReview({
        reviewedBaseSha: base,
        reviewedHeadSha: head,
        reviewerLogin: "-invalid",
      }),
    ).toThrow("reviewer");
  });
});
