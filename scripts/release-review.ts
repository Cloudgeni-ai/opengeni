import { createHash } from "node:crypto";

export interface ExactHeadReleaseReview {
  version: 3;
  kind: "opengeni-exact-head-release-review";
  repository: "Cloudgeni-ai/opengeni";
  reviewedBaseSha: string;
  reviewedHeadSha: string;
  reviewerLogin: string;
  reviewProfile: "exact-head-maintainer-v1";
  verdict: "PASS";
}

const shaPattern = /^[0-9a-f]{40}$/;
const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export function exactHeadReleaseReview(input: {
  reviewedBaseSha: string;
  reviewedHeadSha: string;
  reviewerLogin: string;
}): ExactHeadReleaseReview {
  if (!shaPattern.test(input.reviewedBaseSha)) {
    throw new Error("reviewed base must be a 40-character lowercase Git SHA");
  }
  if (!shaPattern.test(input.reviewedHeadSha)) {
    throw new Error("reviewed head must be a 40-character lowercase Git SHA");
  }
  if (input.reviewedBaseSha === input.reviewedHeadSha) {
    throw new Error("reviewed base and head must differ");
  }
  if (!loginPattern.test(input.reviewerLogin)) {
    throw new Error("reviewer must be a valid GitHub login");
  }
  return {
    version: 3,
    kind: "opengeni-exact-head-release-review",
    repository: "Cloudgeni-ai/opengeni",
    reviewedBaseSha: input.reviewedBaseSha,
    reviewedHeadSha: input.reviewedHeadSha,
    reviewerLogin: input.reviewerLogin,
    reviewProfile: "exact-head-maintainer-v1",
    verdict: "PASS",
  };
}

export function formatExactHeadReleaseReview(review: ExactHeadReleaseReview): string {
  return `<!-- opengeni-exact-head-release-review:v3 -->\n\n\`\`\`json\n${JSON.stringify(review, null, 2)}\n\`\`\``;
}

export function exactHeadReleaseReviewSha256(review: ExactHeadReleaseReview): string {
  const canonical = Object.fromEntries(
    Object.entries(review).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

function main(args: string[]): void {
  const review = exactHeadReleaseReview({
    reviewedBaseSha: option(args, "--base"),
    reviewedHeadSha: option(args, "--head"),
    reviewerLogin: option(args, "--reviewer"),
  });
  const format = args.includes("--digest") ? "digest" : "comment";
  process.stdout.write(
    format === "digest"
      ? `${exactHeadReleaseReviewSha256(review)}\n`
      : `${formatExactHeadReleaseReview(review)}\n`,
  );
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
