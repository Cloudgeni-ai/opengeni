import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PromotionReviewNotice } from "./promotion-review-notice";

test("review notice explains the restriction and carries only the organization reference into a review request", () => {
  const html = renderToStaticMarkup(
    <PromotionReviewNotice
      decision="held"
      accountId="org-a"
      supportEmail="support@opengeni.ai"
      banner
    />,
  );
  expect(html).toContain('role="status"');
  expect(html).toContain("repeated claims are suspected");
  expect(html).toContain("This may be a mistake");
  expect(html).toContain(
    "This review applies to Free credit; purchased credit is not part of the hold",
  );
  expect(html).toContain("You can still sign in");
  expect(html).toContain("Request review");
  const href = html.match(/href="([^"]+)"/)![1]!.replaceAll("&amp;", "&");
  const url = new URL(href);
  expect(url.protocol).toBe("mailto:");
  expect(url.pathname).toBe("support@opengeni.ai");
  expect(url.searchParams.get("subject")).toBe("Request review of Free credit restriction");
  expect(href).not.toContain("+");
  expect(href).toContain("Request%20review");
  expect(url.searchParams.get("body")).toContain("Organization reference: org-a");
  expect(html).not.toContain("Dismiss");
});

test("eligible or unknown funding status renders no notice", () => {
  for (const decision of [undefined, "eligible"] as const) {
    expect(
      renderToStaticMarkup(<PromotionReviewNotice decision={decision} accountId="org-a" />),
    ).toBe("");
  }
});

test("verification has distinct copy and unconfigured deployments do not invent a support address", () => {
  const html = renderToStaticMarkup(
    <PromotionReviewNotice decision="verification_required" accountId="org-a" />,
  );
  expect(html).toContain("Free credit needs verification");
  expect(html).not.toContain("repeated claims");
  expect(html).not.toContain("mailto:");
  expect(html).toContain("deployment administrator");
});

test("denied funding still offers review and safely encodes an organization reference", () => {
  const html = renderToStaticMarkup(
    <PromotionReviewNotice
      decision="denied"
      accountId="org&bcc=elsewhere@example.test"
      supportEmail="support@opengeni.ai"
    />,
  );
  const href = html.match(/href="([^"]+)"/)![1]!.replaceAll("&amp;", "&");
  const url = new URL(href);
  expect(url.searchParams.has("bcc")).toBe(false);
  expect(url.searchParams.get("body")).toContain("org&bcc=elsewhere@example.test");
  expect(html).toContain("Request review");
});
