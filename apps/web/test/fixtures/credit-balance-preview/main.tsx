import React from "react";
import { createRoot } from "react-dom/client";

import { OrganizationCreditBalance } from "../../../src/components/organization-credit-balance";
import type { BillingSummary } from "../../../src/types";
import "../../../src/styles.css";

const sample = (balanceMicros: number): BillingSummary =>
  ({
    mode: "stripe",
    balance: {
      accountId: "preview-only",
      balanceMicros,
      currency: "usd",
      updatedAt: "2026-09-23T12:00:00Z",
    },
  }) as BillingSummary;

function Preview() {
  return (
    <main className="min-h-screen bg-bg px-4 py-8 text-fg sm:px-8">
      <div className="mx-auto max-w-2xl space-y-8">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
            Organization · Billing
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Credit balance preview</h1>
          <p className="mt-1 text-sm text-fg-muted">Sample data · production balance component</p>
        </div>
        <section aria-label="Negative balance" className="grid gap-4 border-b border-border pb-6">
          <OrganizationCreditBalance
            billing={sample(-2_000_000)}
            canReadBilling
            hasAccount
            loading={false}
            hasError={false}
          />
        </section>
        <section aria-label="Positive balance" className="grid gap-4 border-b border-border pb-6">
          <OrganizationCreditBalance
            billing={sample(10_000_000)}
            canReadBilling
            hasAccount
            loading={false}
            hasError={false}
          />
        </section>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Preview />
  </React.StrictMode>,
);