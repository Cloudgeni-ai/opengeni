/**
 * Service-side verifiers for write cases. Each looks for the run marker
 * (`Halcyon eval <RUN>`) in the test account through the service's own API,
 * using a test-account token from the environment. A missing token returns
 * `ran: false` so the row is graded from receipts only and says so.
 *
 * Tokens (all optional; test accounts only):
 *   VERIFY_LINEAR_API_KEY
 *   VERIFY_JIRA_BASE_URL, VERIFY_JIRA_EMAIL, VERIFY_JIRA_API_TOKEN
 *   VERIFY_NOTION_TOKEN
 *   VERIFY_ASANA_TOKEN, VERIFY_ASANA_PROJECT_GID
 *   VERIFY_STRIPE_SECRET_KEY (test mode)
 *   VERIFY_SLACK_TOKEN, VERIFY_SLACK_CHANNEL_ID
 *   VERIFY_GITHUB_TOKEN, VERIFY_GITHUB_REPO (owner/name)
 *   VERIFY_HUBSPOT_TOKEN
 *   VERIFY_SENTRY_TOKEN, VERIFY_SENTRY_ORG, VERIFY_SENTRY_PROJECT
 *   VERIFY_AIRTABLE_TOKEN, VERIFY_AIRTABLE_BASE_ID
 */
import type { Verification } from "./grade";

type Env = Record<string, string | undefined>;
type Verifier = (run: string, env: Env) => Promise<Verification>;

const skipped = (detail: string): Verification => ({ ran: false, ok: null, detail });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${raw.slice(0, 200)}`);
  return raw ? JSON.parse(raw) : null;
}

/** Search indexes lag a little; retry a few times before calling it missing. */
async function poll(
  find: () => Promise<string | { detail: string; count: number } | null>,
  what: string,
): Promise<Verification> {
  let lastError = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const found = await find();
      if (typeof found === "string") return { ran: true, ok: true, detail: found };
      if (found) return { ran: true, ok: true, detail: found.detail, count: found.count };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(4_000 * (attempt + 1));
  }
  return lastError
    ? { ran: false, ok: null, detail: `verifier error: ${lastError}`, error: true }
    : { ran: true, ok: false, detail: `${what} not found` };
}

const need = (env: Env, ...names: string[]): string | null => {
  const missing = names.filter((name) => !env[name]);
  return missing.length > 0 ? `missing ${missing.join(", ")}` : null;
};

const VERIFIERS: Record<string, Verifier> = {
  receipts_only: async () => skipped("no service verifier for this case"),

  linear_issue_exists: async (run, env) => {
    const gap = need(env, "VERIFY_LINEAR_API_KEY");
    if (gap) return skipped(gap);
    return poll(async () => {
      const body = (await json("https://api.linear.app/graphql", {
        method: "POST",
        headers: { authorization: env.VERIFY_LINEAR_API_KEY!, "content-type": "application/json" },
        body: JSON.stringify({
          query:
            "query($q:String!){issues(filter:{title:{containsIgnoreCase:$q}}){nodes{identifier title}}}",
          variables: { q: run },
        }),
      })) as { data?: { issues?: { nodes?: { identifier: string; title: string }[] } } };
      const nodes = body.data?.issues?.nodes ?? [];
      const node = nodes[0];
      return node ? { detail: `${node.identifier} ${node.title}`, count: nodes.length } : null;
    }, "Linear issue");
  },

  jira_issue_exists: async (run, env) => {
    const gap = need(env, "VERIFY_JIRA_BASE_URL", "VERIFY_JIRA_EMAIL", "VERIFY_JIRA_API_TOKEN");
    if (gap) return skipped(gap);
    const auth = Buffer.from(`${env.VERIFY_JIRA_EMAIL}:${env.VERIFY_JIRA_API_TOKEN}`).toString(
      "base64",
    );
    return poll(async () => {
      const jql = encodeURIComponent(`summary ~ "\\"${run}\\""`);
      const body = (await json(
        `${env.VERIFY_JIRA_BASE_URL!.replace(/\/+$/, "")}/rest/api/3/search/jql?jql=${jql}&fields=summary`,
        { headers: { authorization: `Basic ${auth}`, accept: "application/json" } },
      )) as { issues?: { key: string; fields?: { summary?: string } }[] };
      const issues = body.issues ?? [];
      const issue = issues[0];
      return issue
        ? { detail: `${issue.key} ${issue.fields?.summary ?? ""}`, count: issues.length }
        : null;
    }, "Jira issue");
  },

  notion_page_exists: async (run, env) => {
    const gap = need(env, "VERIFY_NOTION_TOKEN");
    if (gap) return skipped(gap);
    return poll(async () => {
      const body = (await json("https://api.notion.com/v1/search", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.VERIFY_NOTION_TOKEN}`,
          "notion-version": "2022-06-28",
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: run, filter: { property: "object", value: "page" } }),
      })) as { results?: { id: string; url?: string }[] };
      const pages = body.results ?? [];
      const page = pages[0];
      return page ? { detail: page.url ?? page.id, count: pages.length } : null;
    }, "Notion page");
  },

  asana_task_exists: async (run, env) => {
    const gap = need(env, "VERIFY_ASANA_TOKEN", "VERIFY_ASANA_PROJECT_GID");
    if (gap) return skipped(gap);
    return poll(async () => {
      // Page through the whole project: new tasks can sit past the first 100.
      const matches: { gid: string; name: string }[] = [];
      let offset: string | undefined;
      for (let page = 0; page < 50; page += 1) {
        const body = (await json(
          `https://app.asana.com/api/1.0/projects/${env.VERIFY_ASANA_PROJECT_GID}/tasks?opt_fields=name&limit=100${offset ? `&offset=${offset}` : ""}`,
          { headers: { authorization: `Bearer ${env.VERIFY_ASANA_TOKEN}` } },
        )) as { data?: { gid: string; name: string }[]; next_page?: { offset?: string } | null };
        matches.push(...(body.data ?? []).filter((item) => item.name.includes(run)));
        offset = body.next_page?.offset;
        if (!offset) break;
      }
      const task = matches[0];
      return task ? { detail: `${task.gid} ${task.name}`, count: matches.length } : null;
    }, "Asana task");
  },

  stripe_customer_exists: async (run, env) => {
    const gap = need(env, "VERIFY_STRIPE_SECRET_KEY");
    if (gap) return skipped(gap);
    if (
      !env.VERIFY_STRIPE_SECRET_KEY!.startsWith("sk_test_") &&
      !env.VERIFY_STRIPE_SECRET_KEY!.startsWith("rk_test_")
    ) {
      return skipped("VERIFY_STRIPE_SECRET_KEY must be a test-mode key");
    }
    return poll(async () => {
      const body = (await json("https://api.stripe.com/v1/customers?limit=50", {
        headers: { authorization: `Bearer ${env.VERIFY_STRIPE_SECRET_KEY}` },
      })) as { data?: { id: string; name?: string | null }[] };
      const customers = (body.data ?? []).filter((item) => (item.name ?? "").includes(run));
      const customer = customers[0];
      return customer
        ? { detail: `${customer.id} ${customer.name}`, count: customers.length }
        : null;
    }, "Stripe customer");
  },

  slack_message_exists: async (run, env) => {
    const gap = need(env, "VERIFY_SLACK_TOKEN", "VERIFY_SLACK_CHANNEL_ID");
    if (gap) return skipped(gap);
    return poll(async () => {
      const body = (await json(
        `https://slack.com/api/conversations.history?channel=${env.VERIFY_SLACK_CHANNEL_ID}&limit=100`,
        { headers: { authorization: `Bearer ${env.VERIFY_SLACK_TOKEN}` } },
      )) as { ok?: boolean; error?: string; messages?: { ts: string; text?: string }[] };
      if (body.ok === false) throw new Error(body.error ?? "slack error");
      const matches = (body.messages ?? []).filter((item) => (item.text ?? "").includes(run));
      return matches[0] ? { detail: `ts ${matches[0].ts}`, count: matches.length } : null;
    }, "Slack message");
  },

  github_issue_exists: async (run, env) => {
    const gap = need(env, "VERIFY_GITHUB_TOKEN", "VERIFY_GITHUB_REPO");
    if (gap) return skipped(gap);
    return poll(async () => {
      const body = (await json(
        `https://api.github.com/repos/${env.VERIFY_GITHUB_REPO}/issues?state=all&sort=created&direction=desc&per_page=50`,
        {
          headers: {
            authorization: `Bearer ${env.VERIFY_GITHUB_TOKEN}`,
            accept: "application/vnd.github+json",
          },
        },
      )) as { number: number; title: string }[];
      const issues = body.filter((item) => item.title.includes(run));
      const issue = issues[0];
      return issue ? { detail: `#${issue.number} ${issue.title}`, count: issues.length } : null;
    }, "GitHub issue");
  },

  hubspot_contact_exists: async (run, env) => {
    const gap = need(env, "VERIFY_HUBSPOT_TOKEN");
    if (gap) return skipped(gap);
    return poll(async () => {
      const body = (await json("https://api.hubapi.com/crm/v3/objects/contacts/search", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.VERIFY_HUBSPOT_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          filterGroups: [
            {
              filters: [
                { propertyName: "email", operator: "EQ", value: `eval-${run}@marlow.example.com` },
              ],
            },
          ],
        }),
      })) as { results?: { id: string }[] };
      const contacts = body.results ?? [];
      const contact = contacts[0];
      return contact ? { detail: `contact ${contact.id}`, count: contacts.length } : null;
    }, "HubSpot contact");
  },

  /**
   * Checks the issue is resolved, then reopens it so the row can run again.
   * Not scoped to a run marker, so the runner caps Sentry rows at one at a time.
   */
  sentry_payment_issue_resolved: async (_run, env) => {
    const gap = need(env, "VERIFY_SENTRY_TOKEN", "VERIFY_SENTRY_ORG", "VERIFY_SENTRY_PROJECT");
    if (gap) return skipped(gap);
    const base = `https://sentry.io/api/0/projects/${env.VERIFY_SENTRY_ORG}/${env.VERIFY_SENTRY_PROJECT}/issues/`;
    const headers = {
      authorization: `Bearer ${env.VERIFY_SENTRY_TOKEN}`,
      "content-type": "application/json",
    };
    const result = await poll(async () => {
      const body = (await json(
        `${base}?query=${encodeURIComponent("HalcyonPaymentError is:resolved")}`,
        {
          headers,
        },
      )) as { id: string; status: string }[];
      const issue = body.find((item) => item.status === "resolved");
      return issue ? `issue ${issue.id} resolved` : null;
    }, "resolved HalcyonPaymentError issue");
    try {
      const resolved = (await json(
        `${base}?query=${encodeURIComponent("HalcyonPaymentError is:resolved")}`,
        {
          headers,
        },
      )) as { id: string }[];
      for (const issue of resolved) {
        await json(`${base}?id=${issue.id}`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ status: "unresolved" }),
        });
      }
    } catch {
      // Reopening is best effort; the next run reports it if it stays resolved.
    }
    return result;
  },

  airtable_record_exists: async (run, env) => {
    const gap = need(env, "VERIFY_AIRTABLE_TOKEN", "VERIFY_AIRTABLE_BASE_ID");
    if (gap) return skipped(gap);
    return poll(async () => {
      const formula = encodeURIComponent(`FIND("${run}", {Name})`);
      const body = (await json(
        `https://api.airtable.com/v0/${env.VERIFY_AIRTABLE_BASE_ID}/Accounts?filterByFormula=${formula}`,
        { headers: { authorization: `Bearer ${env.VERIFY_AIRTABLE_TOKEN}` } },
      )) as { records?: { id: string }[] };
      const rows = body.records ?? [];
      const row = rows[0];
      return row ? { detail: `record ${row.id}`, count: rows.length } : null;
    }, "Airtable record");
  },
};

export function verifierNames(): string[] {
  return Object.keys(VERIFIERS);
}

export async function verify(
  name: string | undefined,
  run: string,
  env: Env = process.env,
): Promise<Verification | null> {
  if (!name) return null;
  const verifier = VERIFIERS[name];
  if (!verifier) return skipped(`unknown verifier ${name}`);
  try {
    return await verifier(run, env);
  } catch (error) {
    return {
      ...skipped(`verifier error: ${error instanceof Error ? error.message : String(error)}`),
      error: true,
    };
  }
}
