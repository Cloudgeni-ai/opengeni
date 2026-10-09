import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { InvoicesSection } from "./org-settings";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

describe("organization Stripe invoices", () => {
  test("renders the finalized PDF download and continues from the exact invoice cursor", async () => {
    const onLoadMore = mock(() => undefined);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <InvoicesSection
          enabled
          loading={false}
          error={null}
          page={{
            invoices: [
              {
                id: "in_test",
                number: "OG-0042",
                status: "paid",
                createdAt: "2025-08-21T12:00:00.000Z",
                totalMicros: 25_500_000,
                amountPaidMicros: 25_500_000,
                currency: "usd",
                invoicePdfUrl: "https://pay.stripe.com/invoice/in_test/pdf",
                hostedInvoiceUrl: "https://invoice.stripe.com/i/in_test",
              },
            ],
            hasMore: true,
            nextCursor: "in_test",
          }}
          onRefresh={() => undefined}
          onLoadMore={onLoadMore}
        />,
      );
    });

    expect(container.textContent).toContain("OG-0042");
    expect(container.textContent).toContain("paid");
    const download = [...container.querySelectorAll("a")].find((anchor) =>
      anchor.textContent?.includes("Download PDF"),
    );
    expect(download?.getAttribute("href")).toBe("https://pay.stripe.com/invoice/in_test/pdf");
    expect(download?.getAttribute("target")).toBe("_blank");
    expect(download?.getAttribute("rel")).toBe("noopener noreferrer");

    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("Load more"))
        ?.click();
    });
    expect(onLoadMore).toHaveBeenCalledWith("in_test");

    await act(async () => root.unmount());
    container.remove();
  });
});
