import type { EvalCase, IntegrationId } from "./types";

/**
 * The integration test catalogue. Every fact below is synthetic fixture data
 * seeded into dedicated test accounts (see README "Fixtures"): the fictional
 * company Halcyon Labs, customers Bluefin Logistics, Copperleaf Dental and
 * Marlow & Finch, and people Ada Quill, Ravi Tern and Mina Sorrel.
 *
 * `{RUN}` in a prompt is replaced with the run's short id so a write can be
 * found again in the service by its verifier.
 *
 * Microsoft 365 test tenant fixtures: an email "Kestrel failover drill moved"
 * saying the drill moves to Thursday 14:00; a OneDrive file "Kestrel runbook"
 * with "Recovery time objective: 15 minutes"; a SharePoint document "Kestrel
 * vendor contacts" naming Marlow & Finch as the backup vendor. Google Drive:
 * a document "Halcyon pricing 2026" listing Pro at 49 USD a month.
 *
 * Kinds: not_connected (run in a workspace with no connections; expects the
 * connect card), read, write (expects an approval; the harness approves and
 * verifies), identity, routing. `core` rows form the model × effort grid.
 */

const i = (pattern: string) => new RegExp(pattern, "i");

function notConnected(
  integration: IntegrationId,
  rows: readonly { slug: string; prompt: string; core?: boolean; forbid?: readonly RegExp[] }[],
): EvalCase[] {
  return rows.map((row) => ({
    id: `${integration}.not_connected.${row.slug}`,
    integration,
    kind: "not_connected",
    prompt: row.prompt,
    ...(row.forbid ? { forbidAnswer: row.forbid } : {}),
    ...(row.core ? { core: true } : {}),
  }));
}

/**
 * Integrations the current programme tests. `--cases core` selects core rows
 * in this scope; other rows stay in the catalogue for later and run when named.
 */
export const DEFAULT_SCOPE: readonly IntegrationId[] = [
  "linear",
  "atlassian",
  "gmail",
  "slack",
  "outlook_mail",
  "onedrive",
  "sharepoint",
  "apollo",
  "google_drive",
];

export const CASES: readonly EvalCase[] = [
  // ── Linear ───────────────────────────────────────────────────────────────
  ...notConnected("linear", [
    {
      slug: "my-issues",
      prompt: "What Linear issues are assigned to me right now?",
      core: true,
      forbid: [/HAL-\d+/],
    },
    { slug: "file-bug", prompt: "File a Linear bug: the invoice PDF shows the wrong VAT number." },
  ]),
  {
    id: "linear.read.urgent",
    integration: "linear",
    kind: "read",
    core: true,
    prompt: "Which issue in our Halcyon team on Linear is marked Urgent, and what state is it in?",
    expectAnswer: [i("checkout times out"), i("in progress")],
  },
  {
    id: "linear.read.project",
    integration: "linear",
    kind: "read",
    prompt: 'List the issues in the Linear project "Halcyon Q4 launch".',
    expectAnswer: [i("checkout times out"), i("csv export")],
  },
  {
    id: "linear.read.done",
    integration: "linear",
    kind: "read",
    prompt: "Did we finish the Copperleaf Dental onboarding checklist? Check Linear.",
    expectAnswer: [i("done|complete|finished")],
  },
  {
    id: "linear.write.create-issue",
    integration: "linear",
    kind: "write",
    core: true,
    prompt:
      'Create a Linear issue in the Halcyon team titled "Halcyon eval {RUN}: refund button greyed out" with priority Low.',
    verify: "linear_issue_exists",
  },
  {
    id: "linear.identity.account",
    integration: "linear",
    kind: "identity",
    core: true,
    prompt: "Which Linear workspace and user are you connected to?",
    expectAnswer: [i("halcyon|it-linear")],
  },

  // ── Atlassian (Jira + Confluence, v2 MCP with ?tools=all) ─────────────────
  ...notConnected("atlassian", [
    {
      slug: "jira-sprint",
      prompt: "What's in progress in our Jira project right now?",
      core: true,
      forbid: [/KOPS-\d+/],
    },
    { slug: "confluence-page", prompt: "Find the on-call rota page in Confluence." },
  ]),
  {
    id: "atlassian.read.jira-in-progress",
    integration: "atlassian",
    kind: "read",
    core: true,
    prompt: "Which Jira issue in the Kestrel Ops project is in progress, and what's its priority?",
    expectAnswer: [i("failover drill"), i("high")],
  },
  {
    id: "atlassian.read.confluence-rota",
    integration: "atlassian",
    kind: "read",
    core: true,
    prompt:
      'According to the "Kestrel on-call rota" page in Confluence, who is on call in week 46?',
    expectAnswer: [i("mina sorrel")],
  },
  {
    id: "atlassian.read.jira-todo",
    integration: "atlassian",
    kind: "read",
    prompt:
      "Is there a Jira ticket about renewing the Kestrel TLS certificates? What status is it?",
    expectAnswer: [i("to do|todo|open")],
  },
  {
    id: "atlassian.write.jira-issue",
    integration: "atlassian",
    kind: "write",
    core: true,
    prompt:
      'Create a Jira task in the Kestrel Ops project (KOPS) called "Halcyon eval {RUN}: rotate SSH keys".',
    verify: "jira_issue_exists",
  },
  {
    id: "atlassian.identity.site",
    integration: "atlassian",
    kind: "identity",
    prompt: "Which Atlassian site and account are you using for Jira?",
    expectAnswer: [i("atlassian\\.net|it-atlassian")],
  },

  // ── Notion ────────────────────────────────────────────────────────────────
  ...notConnected("notion", [
    {
      slug: "launch-plan",
      prompt: "Open our launch plan in Notion and tell me the launch date.",
      core: true,
      forbid: [i("2026-12-01|1 december")],
    },
    { slug: "vendors", prompt: "Add a row to my Notion vendors database." },
  ]),
  {
    id: "notion.read.launch-date",
    integration: "notion",
    kind: "read",
    core: true,
    prompt: 'In Notion, what launch date and owner does the "Halcyon launch plan" page give?',
    expectAnswer: [i("12-01|1 dec|december 1"), i("ada")],
  },
  {
    id: "notion.read.vendors-paused",
    integration: "notion",
    kind: "read",
    prompt: "Which vendor in the Halcyon vendors database in Notion is paused?",
    expectAnswer: [i("copperleaf")],
  },
  {
    id: "notion.read.risks",
    integration: "notion",
    kind: "read",
    prompt: "What risks are listed in our Halcyon launch plan in Notion?",
    expectAnswer: [i("payment provider")],
  },
  {
    id: "notion.write.page",
    integration: "notion",
    kind: "write",
    prompt:
      'Create a Notion page called "Halcyon eval {RUN} retro notes" with one bullet: "Launch went smoothly". Put it under the Halcyon launch plan page.',
    verify: "notion_page_exists",
  },
  {
    id: "notion.identity.workspace",
    integration: "notion",
    kind: "identity",
    prompt: "Which Notion workspace are you connected to?",
    expectAnswer: [i("notion")],
  },

  // ── Asana ─────────────────────────────────────────────────────────────────
  ...notConnected("asana", [
    { slug: "my-tasks", prompt: "What Asana tasks are due for me this month?", core: true },
  ]),
  {
    id: "asana.read.due",
    integration: "asana",
    kind: "read",
    core: true,
    prompt: 'When is the "Write Halcyon Pro pricing page" task due in Asana?',
    expectAnswer: [i("11-20|20 nov|november 20|nov 20")],
  },
  {
    id: "asana.read.project",
    integration: "asana",
    kind: "read",
    prompt: 'Which tasks in the Asana project "Halcyon marketing site" are still open?',
    expectAnswer: [i("pricing page"), i("demo video")],
  },
  {
    id: "asana.write.task",
    integration: "asana",
    kind: "write",
    prompt:
      'Add a task "Halcyon eval {RUN}: update screenshots" to the Asana project Halcyon marketing site.',
    verify: "asana_task_exists",
  },

  // ── Stripe (test mode) ────────────────────────────────────────────────────
  ...notConnected("stripe", [
    { slug: "revenue", prompt: "How many customers do we have in Stripe?", core: true },
  ]),
  {
    id: "stripe.read.customers",
    integration: "stripe",
    kind: "read",
    core: true,
    prompt: "List our Stripe customers with their emails.",
    expectAnswer: [i("bluefin"), i("copperleaf")],
  },
  {
    id: "stripe.read.price",
    integration: "stripe",
    kind: "read",
    prompt: "What does the Halcyon Pro product cost per month in Stripe?",
    expectAnswer: [i("\\b49\\b")],
  },
  {
    id: "stripe.write.customer",
    integration: "stripe",
    kind: "write",
    prompt:
      'Create a Stripe customer named "Halcyon eval {RUN} Marlow & Finch" with email billing@marlow.example.com.',
    verify: "stripe_customer_exists",
  },

  // ── Slack (MCP and workspace bot tools) ───────────────────────────────────
  ...notConnected("slack", [
    {
      slug: "channel-summary",
      prompt: "Summarize what happened in #halcyon-launch on Slack today.",
      core: true,
    },
  ]),
  {
    id: "slack.read.launch",
    integration: "slack",
    kind: "read",
    core: true,
    prompt: "What was said in the #halcyon-launch Slack channel about the launch date?",
    expectAnswer: [i("1 dec|december 1|dec 1")],
  },
  {
    id: "slack.read.support",
    integration: "slack",
    kind: "read",
    prompt: "Any customer complaints in #halcyon-support on Slack?",
    expectAnswer: [i("bluefin"), i("timeout|time out|times out")],
  },
  {
    id: "slack.write.post",
    integration: "slack",
    kind: "write",
    core: true,
    prompt:
      'Post in #halcyon-launch on Slack: "Halcyon eval {RUN}: pricing page draft is ready for review".',
    verify: "slack_message_exists",
  },

  // ── GitHub ────────────────────────────────────────────────────────────────
  ...notConnected("github", [
    { slug: "open-prs", prompt: "Which pull requests are open on our halcyon-demo GitHub repo?" },
  ]),
  {
    id: "github.read.issues",
    integration: "github",
    kind: "read",
    core: true,
    prompt: "What open issues does the halcyon-demo repository on GitHub have?",
    expectAnswer: [i("checkout button"), i("dark mode")],
  },
  {
    id: "github.read.pr",
    integration: "github",
    kind: "read",
    prompt: "Is there an open pull request in halcyon-demo? What does it change?",
    expectAnswer: [i("padding|checkout button")],
  },
  {
    id: "github.write.issue",
    integration: "github",
    kind: "write",
    prompt:
      'Open a GitHub issue in halcyon-demo titled "Halcyon eval {RUN}: footer link is broken".',
    verify: "github_issue_exists",
  },

  // ── HubSpot ───────────────────────────────────────────────────────────────
  ...notConnected("hubspot", [
    { slug: "deals", prompt: "What deals do we have open in HubSpot?", core: true },
  ]),
  {
    id: "hubspot.read.deal",
    integration: "hubspot",
    kind: "read",
    core: true,
    prompt: "What's the amount and stage of the Bluefin Logistics renewal deal in HubSpot?",
    expectAnswer: [i("12,?000|12k"), i("contract")],
  },
  {
    id: "hubspot.read.contact",
    integration: "hubspot",
    kind: "read",
    prompt: "Who is our contact at Copperleaf Dental in HubSpot, and what's their email?",
    expectAnswer: [i("otto"), i("otto@copperleaf\\.example\\.com")],
  },
  {
    id: "hubspot.write.contact",
    integration: "hubspot",
    kind: "write",
    prompt:
      "Add a HubSpot contact: first name Halcyon, last name Eval {RUN}, email eval-{RUN}@marlow.example.com.",
    verify: "hubspot_contact_exists",
  },

  // ── Sentry ────────────────────────────────────────────────────────────────
  ...notConnected("sentry", [
    { slug: "top-errors", prompt: "What are the top errors in Sentry this week?", core: true },
  ]),
  {
    id: "sentry.read.top-error",
    integration: "sentry",
    kind: "read",
    core: true,
    prompt: "What is the most frequent unresolved error in the halcyon-web Sentry project?",
    expectAnswer: [i("cartId|cannot read properties")],
  },
  {
    id: "sentry.read.payment",
    integration: "sentry",
    kind: "read",
    prompt: "Did Sentry catch any payment errors in halcyon-web?",
    expectAnswer: [i("card_declined|HalcyonPaymentError")],
  },
  {
    id: "sentry.write.resolve",
    integration: "sentry",
    kind: "write",
    prompt: "In Sentry, mark the HalcyonPaymentError issue in halcyon-web as resolved.",
    verify: "sentry_payment_issue_resolved",
  },

  // ── Airtable ──────────────────────────────────────────────────────────────
  ...notConnected("airtable", [
    { slug: "crm", prompt: "Look up our accounts in the Airtable CRM base.", core: true },
  ]),
  {
    id: "airtable.read.mrr",
    integration: "airtable",
    kind: "read",
    core: true,
    prompt:
      "In the Halcyon CRM base in Airtable, which account has the highest MRR and how much is it?",
    expectAnswer: [i("marlow"), i("5,?400")],
  },
  {
    id: "airtable.read.trial",
    integration: "airtable",
    kind: "read",
    prompt: "Which Airtable accounts in Halcyon CRM are on a trial?",
    expectAnswer: [i("copperleaf")],
  },
  {
    id: "airtable.write.record",
    integration: "airtable",
    kind: "write",
    prompt:
      'Add a record to the Accounts table in the Halcyon CRM Airtable base: Name "Halcyon eval {RUN}", Plan Starter, MRR 19, Status Trial.',
    verify: "airtable_record_exists",
  },

  // ── Apollo.io (its own people database; read only) ────────────────────────
  ...notConnected("apollo", [
    {
      slug: "prospects",
      prompt: "Find me three VP Engineering prospects at logistics companies in Apollo.",
      core: true,
    },
  ]),
  {
    id: "apollo.read.people",
    integration: "apollo",
    kind: "read",
    core: true,
    prompt: "Use Apollo to find who leads engineering at Stripe.",
    note: "Reads Apollo's own people database; graded on the Apollo tool receipt.",
  },

  // ── PostHog ───────────────────────────────────────────────────────────────
  ...notConnected("posthog", [
    { slug: "signups", prompt: "How many signups did we get this week in PostHog?" },
  ]),
  {
    id: "posthog.read.events",
    integration: "posthog",
    kind: "read",
    prompt: "In PostHog, how many checkout_failed events do we have, and what reason do they give?",
    expectAnswer: [i("\\b3\\b|three"), i("card_declined|card declined")],
  },

  // ── Vercel ────────────────────────────────────────────────────────────────
  ...notConnected("vercel", [
    { slug: "deployments", prompt: "Is our latest Vercel deployment healthy?" },
  ]),
  {
    id: "vercel.read.project",
    integration: "vercel",
    kind: "read",
    prompt: "What's the status of the latest deployment of halcyon-landing on Vercel?",
    expectAnswer: [i("ready|success")],
  },

  // ── Supabase ──────────────────────────────────────────────────────────────
  ...notConnected("supabase", [
    { slug: "orders", prompt: "Query our Supabase orders table for pending orders." },
  ]),
  {
    id: "supabase.read.pending",
    integration: "supabase",
    kind: "read",
    prompt: "In the halcyon Supabase project, which orders are pending?",
    expectAnswer: [i("copperleaf")],
  },

  // ── Cloudflare ────────────────────────────────────────────────────────────
  ...notConnected("cloudflare", [
    { slug: "kv", prompt: "Which feature flags are on in our Cloudflare KV namespace?" },
  ]),
  {
    id: "cloudflare.read.kv",
    integration: "cloudflare",
    kind: "read",
    prompt: "What's the value of checkout_v2 in the halcyon-flags KV namespace on Cloudflare?",
    expectAnswer: [i("true")],
  },

  // ── Dropbox ───────────────────────────────────────────────────────────────
  ...notConnected("dropbox", [
    { slug: "pricing", prompt: "Open the pricing file in my Dropbox and tell me the Pro price." },
  ]),
  {
    id: "dropbox.read.pricing",
    integration: "dropbox",
    kind: "read",
    prompt: "In Dropbox, what does /Halcyon/pricing-2026.txt say the Pro plan costs?",
    expectAnswer: [i("\\b49\\b")],
  },

  // ── Canva ─────────────────────────────────────────────────────────────────
  ...notConnected("canva", [{ slug: "designs", prompt: "List my Canva designs." }]),
  {
    id: "canva.read.designs",
    integration: "canva",
    kind: "read",
    prompt: "Do I have a Canva design for the Halcyon launch? What is it called?",
    expectAnswer: [i("halcyon launch banner")],
  },

  // ── Front ─────────────────────────────────────────────────────────────────
  ...notConnected("front", [
    { slug: "inbox", prompt: "What's waiting in our Front support inbox?" },
  ]),
  {
    id: "front.read.refund",
    integration: "front",
    kind: "read",
    prompt: "Is there a refund question in our Front inbox? Who sent it?",
    expectAnswer: [i("mina")],
  },

  // ── Gmail and Google Calendar (test Google account) ───────────────────────
  ...notConnected("gmail", [
    { slug: "unread", prompt: "Summarize my unread emails from today.", core: true },
    {
      slug: "draft",
      prompt: "Draft a reply in Gmail to the last email from Ada saying I'll review it tomorrow.",
    },
  ]),
  {
    id: "gmail.read.subject",
    integration: "gmail",
    kind: "read",
    core: true,
    prompt:
      "Find the email about the Halcyon launch checklist in my Gmail and tell me who sent it.",
    expectAnswer: [i("ada")],
  },
  {
    id: "gmail.write.draft",
    integration: "gmail",
    kind: "write",
    core: true,
    prompt:
      'Create a Gmail draft to ada.quill@example.com with subject "Halcyon eval {RUN}" and body "Thanks, looks good." Don\'t send it.',
    verify: "receipts_only",
  },
  ...notConnected("google_calendar", [
    { slug: "today", prompt: "What's on my Google Calendar tomorrow?" },
  ]),
  {
    id: "google_calendar.read.review",
    integration: "google_calendar",
    kind: "read",
    prompt: "When is the Halcyon launch review on my Google Calendar?",
    expectAnswer: [i("halcyon launch review|launch review")],
  },

  // ── Google Drive (off in production until Google verification; staging) ──
  ...notConnected("google_drive", [
    { slug: "pricing", prompt: "Find the Halcyon pricing sheet in my Google Drive.", core: true },
  ]),
  {
    id: "google_drive.read.pricing",
    integration: "google_drive",
    kind: "read",
    core: true,
    prompt: "In my Google Drive, what does the Halcyon pricing 2026 document say Pro costs?",
    expectAnswer: [i("\\b49\\b")],
  },

  // ── Microsoft 365 (test tenant account) ───────────────────────────────────
  ...notConnected("outlook_mail", [
    {
      slug: "inbox",
      prompt: "Check my Outlook inbox for anything about the Kestrel failover drill.",
      core: true,
    },
  ]),
  {
    id: "outlook_mail.read.drill",
    integration: "outlook_mail",
    kind: "read",
    core: true,
    prompt: "In my Outlook mail, when was the Kestrel failover drill moved to?",
    expectAnswer: [i("thursday")],
  },
  {
    id: "outlook_mail.write.draft",
    integration: "outlook_mail",
    kind: "write",
    core: true,
    prompt:
      'Create an Outlook draft to ravi.tern@example.com with subject "Halcyon eval {RUN}" and body "Drill notes received." Don\'t send it.',
    verify: "receipts_only",
  },
  ...notConnected("outlook_calendar", [
    { slug: "meetings", prompt: "What meetings do I have in Outlook Calendar this week?" },
  ]),
  ...notConnected("onedrive", [
    { slug: "files", prompt: "Find the Kestrel runbook in my OneDrive.", core: true },
  ]),
  {
    id: "onedrive.read.runbook",
    integration: "onedrive",
    kind: "read",
    core: true,
    prompt: "Open the Kestrel runbook in my OneDrive. What recovery time objective does it set?",
    expectAnswer: [i("15 ?min")],
  },
  ...notConnected("sharepoint", [
    { slug: "sites", prompt: "Search our SharePoint for the Kestrel vendor contacts.", core: true },
  ]),
  {
    id: "sharepoint.read.vendors",
    integration: "sharepoint",
    kind: "read",
    core: true,
    prompt: "On our SharePoint, who is the backup vendor in the Kestrel vendor contacts document?",
    expectAnswer: [i("marlow")],
  },

  // ── Choosing between integrations ─────────────────────────────────────────
  {
    id: "routing.linear-vs-jira.urgent",
    integration: "linear",
    kind: "routing",
    core: true,
    prompt: "Which of our Halcyon engineering issues is urgent right now?",
    expectAnswer: [i("checkout times out")],
    forbidIntegrations: ["atlassian"],
    note: "Halcyon issues live in Linear; Kestrel issues live in Jira.",
  },
  {
    id: "routing.linear-vs-jira.kestrel",
    integration: "atlassian",
    kind: "routing",
    core: true,
    prompt: "What's the status of the Kestrel failover drill ticket?",
    expectAnswer: [i("in progress")],
    forbidIntegrations: ["linear"],
  },
  {
    id: "routing.slack-vs-gmail.bluefin",
    integration: "slack",
    kind: "routing",
    core: true,
    prompt: "What did the team say about Bluefin's checkout timeouts in chat?",
    expectAnswer: [i("bluefin")],
    forbidIntegrations: ["gmail"],
  },
  {
    id: "routing.gmail-vs-outlook.drill",
    integration: "outlook_mail",
    kind: "routing",
    core: true,
    prompt: "Did I get an email saying when the Kestrel failover drill was moved to?",
    expectAnswer: [i("thursday")],
    note: "Only the Microsoft mailbox has this email; Gmail has the Halcyon checklist.",
  },
  {
    id: "routing.onedrive-vs-sharepoint.runbook",
    integration: "onedrive",
    kind: "routing",
    core: true,
    prompt: "What recovery time objective does my Kestrel runbook file set?",
    expectAnswer: [i("15 ?min")],
    forbidIntegrations: ["atlassian"],
  },
  {
    id: "routing.sharepoint-vs-confluence.vendor",
    integration: "sharepoint",
    kind: "routing",
    core: true,
    prompt: "Who do we list as the Kestrel backup vendor in our shared documents?",
    expectAnswer: [i("marlow")],
    forbidIntegrations: ["atlassian"],
  },
  {
    id: "routing.notion-vs-confluence.rota",
    integration: "atlassian",
    kind: "routing",
    prompt: "Who is on call in week 47 according to our wiki?",
    expectAnswer: [i("ada")],
    forbidIntegrations: ["notion"],
  },
  {
    id: "routing.notion-vs-confluence.launch",
    integration: "notion",
    kind: "routing",
    prompt: "What does our launch plan doc list as the main risk?",
    expectAnswer: [i("payment provider")],
    forbidIntegrations: ["atlassian"],
  },
  {
    id: "routing.stripe-vs-hubspot.price",
    integration: "stripe",
    kind: "routing",
    core: true,
    prompt: "What price did we set up for Halcyon Pro billing?",
    expectAnswer: [i("\\b49\\b")],
    forbidIntegrations: ["hubspot"],
  },
  {
    id: "routing.stripe-vs-hubspot.deal",
    integration: "hubspot",
    kind: "routing",
    prompt: "How big is the Bluefin renewal we're negotiating?",
    expectAnswer: [i("12,?000|12k")],
    forbidIntegrations: ["stripe"],
  },
  {
    id: "routing.airtable-vs-supabase.mrr",
    integration: "airtable",
    kind: "routing",
    prompt: "What MRR do we track for Copperleaf Dental in our CRM?",
    expectAnswer: [i("\\b300\\b")],
    forbidIntegrations: ["supabase", "hubspot"],
  },
  {
    id: "routing.asana-vs-linear.pricing",
    integration: "asana",
    kind: "routing",
    prompt: "Who owns the pricing page task for the marketing site, and when is it due?",
    expectAnswer: [i("11-20|20 nov|november 20|nov 20")],
    forbidIntegrations: ["linear"],
  },
  {
    id: "routing.github-vs-linear.padding",
    integration: "github",
    kind: "routing",
    prompt: "Is there an open PR that fixes the checkout button padding?",
    expectAnswer: [i("padding")],
    forbidIntegrations: ["linear"],
  },
  {
    id: "routing.sentry-vs-posthog.declines",
    integration: "posthog",
    kind: "routing",
    prompt: "How many users hit checkout_failed in our product analytics?",
    expectAnswer: [i("\\b3\\b|three")],
    forbidIntegrations: ["sentry"],
  },
];

export function caseById(id: string): EvalCase | undefined {
  return CASES.find((testCase) => testCase.id === id);
}
