import { ListBillingReceiptsResponse, type BillingReceipt } from "@opengeni/contracts";
import type Stripe from "stripe";

// Subscription invoices are created before Stripe collects them, and failed
// collections are retried for weeks. Checkout invoices follow their payment.
const INVOICE_LOOKBACK_SECONDS = 45 * 24 * 60 * 60;
const INVOICE_LOOKAHEAD_SECONDS = 24 * 60 * 60;

type ReceiptStripe = Pick<Stripe, "charges" | "invoices">;

/**
 * One page of a customer's successful payments, newest first. Every payment
 * has a charge, including automatic top-ups that never get an invoice, so
 * charges are the list; invoices only add their own page and PDF.
 */
export async function listStripeReceipts(
  stripe: ReceiptStripe,
  customerId: string,
  page: { cursor?: string | undefined; limit: number },
): Promise<ListBillingReceiptsResponse> {
  const charges = await stripe.charges.list({
    customer: customerId,
    limit: page.limit,
    ...(page.cursor ? { starting_after: page.cursor } : {}),
    expand: ["data.payment_intent"],
  });
  const paid = charges.data.filter((charge) => charge.paid && charge.status === "succeeded");
  const invoices = await invoicesByPayment(stripe, customerId, paid);
  return ListBillingReceiptsResponse.parse({
    receipts: paid.map((charge) => billingReceipt(charge, invoiceFor(charge, invoices))),
    nextCursor: charges.has_more ? (charges.data.at(-1)?.id ?? null) : null,
  });
}

export function billingReceipt(
  charge: Stripe.Charge,
  invoice: Stripe.Invoice | null,
): BillingReceipt {
  const intent = typeof charge.payment_intent === "object" ? charge.payment_intent : null;
  const metadata = { ...intent?.metadata, ...invoice?.metadata, ...charge.metadata };
  const { kind, description } = receiptPurpose(charge, invoice, metadata);
  return {
    id: charge.id,
    createdAt: new Date(charge.created * 1000).toISOString(),
    kind,
    description,
    amount: charge.amount,
    currency: charge.currency,
    amountRefunded: charge.amount_refunded,
    refunded: charge.refunded,
    receiptUrl: charge.receipt_url ?? null,
    invoiceUrl: invoice?.hosted_invoice_url ?? null,
    invoicePdfUrl: invoice?.invoice_pdf ?? null,
  };
}

function receiptPurpose(
  charge: Stripe.Charge,
  invoice: Stripe.Invoice | null,
  metadata: Record<string, string>,
): Pick<BillingReceipt, "kind" | "description"> {
  if (metadata.opengeni_auto_top_up_v1 === "1") {
    return { kind: "auto_top_up", description: "Automatic top-up" };
  }
  if (
    invoice &&
    (invoice.parent?.type === "subscription_details" ||
      invoice.billing_reason?.startsWith("subscription"))
  ) {
    return { kind: "plan", description: "Plan" };
  }
  if (metadata.opengeni_credit_coupon_v1 === "1" || metadata.opengeni_credit_micros) {
    return { kind: "credits", description: "Credits" };
  }
  return { kind: "other", description: charge.description?.trim() || "Payment" };
}

function invoiceFor(
  charge: Stripe.Charge,
  invoices: Map<string, Stripe.Invoice>,
): Stripe.Invoice | null {
  const intentId = stripeId(charge.payment_intent);
  return invoices.get(charge.id) ?? (intentId ? invoices.get(intentId) : undefined) ?? null;
}

// Invoice payments moved off charge.invoice and invoice.payment_intent in v22:
// an invoice now lists the PaymentIntents and charges that paid it. One
// bounded read covers the invoices around this page of charges.
async function invoicesByPayment(
  stripe: ReceiptStripe,
  customerId: string,
  charges: readonly Stripe.Charge[],
): Promise<Map<string, Stripe.Invoice>> {
  const byPayment = new Map<string, Stripe.Invoice>();
  if (charges.length === 0) return byPayment;
  const created = charges.map((charge) => charge.created);
  const invoices = await stripe.invoices.list({
    customer: customerId,
    created: {
      gte: Math.min(...created) - INVOICE_LOOKBACK_SECONDS,
      lte: Math.max(...created) + INVOICE_LOOKAHEAD_SECONDS,
    },
    limit: 100,
    expand: ["data.payments"],
  });
  for (const invoice of invoices.data) {
    for (const payment of invoice.payments?.data ?? []) {
      for (const paymentId of [
        stripeId(payment.payment.payment_intent),
        stripeId(payment.payment.charge),
      ]) {
        if (paymentId && !byPayment.has(paymentId)) byPayment.set(paymentId, invoice);
      }
    }
  }
  return byPayment;
}

function stripeId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}
