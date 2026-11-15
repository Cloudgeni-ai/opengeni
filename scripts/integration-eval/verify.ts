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
 *   VERIFY_GRAPH_TENANT_ID, VERIFY_GRAPH_CLIENT_ID, VERIFY_GRAPH_CLIENT_SECRET (a read-only
 *     app in the Microsoft 365 test tenant), VERIFY_GRAPH_USER (the connected test user),
 *     VERIFY_GRAPH_RECIPIENT (the test mailbox that receives sends),
 *     VERIFY_GRAPH_SP_SITE_ID (the SharePoint test site)
 *
 * The Microsoft 365 verifiers also check that the created object is correct:
 * recipients, body, time and attendees, and where a file was saved.
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
      // A clean "not found" after an earlier error replaces that error.
      lastError = "";
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

type Checked = { detail: string; problems: string[]; count: number };

/** Like `poll`, but a found object can still be wrong; the last wrong find is reported. */
async function pollChecked(find: () => Promise<Checked | null>, what: string): Promise<Verification> {
  let lastError = "";
  let wrong: Checked | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const found = await find();
      lastError = "";
      if (found && found.problems.length === 0) {
        return { ran: true, ok: true, detail: found.detail, count: found.count };
      }
      if (found) wrong = found;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(4_000 * (attempt + 1));
  }
  if (wrong) {
    return {
      ran: true,
      ok: false,
      detail: `${what} is wrong: ${wrong.problems.join("; ")} (${wrong.detail})`,
      count: wrong.count,
    };
  }
  return lastError
    ? { ran: false, ok: null, detail: `verifier error: ${lastError}`, error: true }
    : { ran: true, ok: false, detail: `${what} not found` };
}

const GRAPH_ENV = ["VERIFY_GRAPH_TENANT_ID", "VERIFY_GRAPH_CLIENT_ID", "VERIFY_GRAPH_CLIENT_SECRET"];
const graphTokens = new Map<string, { token: string; expires: number }>();

async function graphToken(env: Env): Promise<string> {
  const key = `${env.VERIFY_GRAPH_TENANT_ID}/${env.VERIFY_GRAPH_CLIENT_ID}`;
  const cached = graphTokens.get(key);
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const body = (await json(
    `https://login.microsoftonline.com/${encodeURIComponent(env.VERIFY_GRAPH_TENANT_ID!)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: env.VERIFY_GRAPH_CLIENT_ID!,
        client_secret: env.VERIFY_GRAPH_CLIENT_SECRET!,
        scope: "https://graph.microsoft.com/.default",
      }).toString(),
    },
  )) as { access_token: string; expires_in: number };
  graphTokens.set(key, { token: body.access_token, expires: Date.now() + body.expires_in * 1000 });
  return body.access_token;
}

async function graph<T>(env: Env, path: string, headers: Record<string, string> = {}): Promise<T> {
  const token = await graphToken(env);
  return (await json(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...headers },
  })) as T;
}

async function graphText(env: Env, path: string): Promise<string> {
  const token = await graphToken(env);
  // Graph answers file content with a redirect to a pre-signed URL; fetch follows it.
  const response = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`);
  return response.text();
}

const user = (env: Env, name = "VERIFY_GRAPH_USER") =>
  `/users/${encodeURIComponent(env[name]!)}`;
const plain = (html: string | undefined) =>
  (html ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const addresses = (list: { emailAddress?: { address?: string } }[] | undefined) =>
  (list ?? []).map((entry) => (entry.emailAddress?.address ?? "").toLowerCase());

type GraphMessage = {
  id: string;
  subject?: string;
  isDraft?: boolean;
  toRecipients?: { emailAddress?: { address?: string } }[];
  ccRecipients?: { emailAddress?: { address?: string } }[];
  bccRecipients?: { emailAddress?: { address?: string } }[];
  body?: { content?: string };
};

async function messagesIn(env: Env, mailbox: string, folder: string): Promise<GraphMessage[]> {
  const select = "subject,isDraft,toRecipients,ccRecipients,bccRecipients,body";
  const body = await graph<{ value?: GraphMessage[] }>(
    env,
    `${mailbox}/mailFolders('${folder}')/messages?$top=50&$orderby=lastModifiedDateTime desc&$select=${select}`,
    { prefer: 'outlook.body-content-type="text"' },
  );
  return body.value ?? [];
}

type DriveItem = { id: string; name: string; parentReference?: { path?: string } };

/** Finds a run's file in `folder` of a drive, or elsewhere in that drive (a wrong location). */
async function checkDriveFile(
  env: Env,
  drive: string,
  folder: string,
  run: string,
  content: string,
): Promise<Checked | null> {
  const inFolder = await graph<{ value?: DriveItem[] }>(
    env,
    `${drive}/root:/${encodeURIComponent(folder)}:/children?$top=200&$select=id,name,parentReference`,
  );
  let matches = (inFolder.value ?? []).filter((item) => item.name.includes(run));
  const problems: string[] = [];
  if (matches.length === 0) {
    const anywhere = await graph<{ value?: DriveItem[] }>(
      env,
      `${drive}/root/search(q='${encodeURIComponent(run.replace(/'/g, "''"))}')?$select=id,name,parentReference`,
    );
    matches = (anywhere.value ?? []).filter((item) => item.name.includes(run));
    if (matches.length === 0) return null;
    problems.push(`saved in ${matches[0]!.parentReference?.path ?? "another folder"}, not ${folder}`);
  }
  const item = matches[0]!;
  if (!/\.txt$/i.test(item.name)) problems.push(`named ${item.name}`);
  const text = await graphText(env, `${drive}/items/${item.id}/content`);
  if (!text.includes(content)) problems.push(`content is "${text.slice(0, 80)}"`);
  return { detail: `${item.parentReference?.path ?? ""}/${item.name}`, problems, count: matches.length };
}

const VERIFIERS: Record<string, Verifier> = {
  receipts_only: async () => skipped("no service verifier for this case"),

  outlook_mail_sent_correct: async (run, env) => {
    const gap = need(env, ...GRAPH_ENV, "VERIFY_GRAPH_USER", "VERIFY_GRAPH_RECIPIENT");
    if (gap) return skipped(gap);
    const recipient = env.VERIFY_GRAPH_RECIPIENT!.toLowerCase();
    return pollChecked(async () => {
      const sent = (await messagesIn(env, user(env), "SentItems")).filter((message) =>
        (message.subject ?? "").includes(run),
      );
      const message = sent[0];
      if (!message) return null;
      const problems: string[] = [];
      const to = addresses(message.toRecipients);
      const others = [...addresses(message.ccRecipients), ...addresses(message.bccRecipients)];
      if (to.length !== 1 || to[0] !== recipient) problems.push(`to ${to.join(", ") || "nobody"}`);
      if (others.length > 0) problems.push(`also copied ${others.join(", ")}`);
      if (!plain(message.body?.content).includes("Send test from the integration eval")) {
        problems.push(`body is "${plain(message.body?.content).slice(0, 80)}"`);
      }
      const inbox = await messagesIn(env, user(env, "VERIFY_GRAPH_RECIPIENT"), "Inbox");
      if (!inbox.some((received) => (received.subject ?? "").includes(run))) {
        problems.push("not yet in the recipient's inbox");
      }
      return { detail: `sent "${message.subject}" to ${to.join(", ")}`, problems, count: sent.length };
    }, "sent Outlook message");
  },

  /** For denied sends: any sent copy means the service changed. */
  outlook_mail_sent_exists: async (run, env) => {
    const gap = need(env, ...GRAPH_ENV, "VERIFY_GRAPH_USER");
    if (gap) return skipped(gap);
    return poll(async () => {
      const sent = (await messagesIn(env, user(env), "SentItems")).filter((message) =>
        (message.subject ?? "").includes(run),
      );
      return sent[0] ? { detail: `sent "${sent[0].subject}"`, count: sent.length } : null;
    }, "sent Outlook message");
  },

  outlook_draft_correct: async (run, env) => {
    const gap = need(env, ...GRAPH_ENV, "VERIFY_GRAPH_USER");
    if (gap) return skipped(gap);
    return pollChecked(async () => {
      const drafts = (await messagesIn(env, user(env), "Drafts")).filter((message) =>
        (message.subject ?? "").includes(run),
      );
      const sent = (await messagesIn(env, user(env), "SentItems")).filter((message) =>
        (message.subject ?? "").includes(run),
      );
      const message = drafts[0];
      if (!message) return sent.length > 0
        ? { detail: "sent instead of drafted", problems: ["the message was sent"], count: sent.length }
        : null;
      const problems: string[] = [];
      const to = addresses(message.toRecipients);
      if (to.length !== 1 || to[0] !== "ravi.tern@example.com") problems.push(`to ${to.join(", ") || "nobody"}`);
      if (!plain(message.body?.content).includes("Drill notes received")) {
        problems.push(`body is "${plain(message.body?.content).slice(0, 80)}"`);
      }
      if (sent.length > 0) problems.push("a copy was also sent");
      return { detail: `draft "${message.subject}"`, problems, count: drafts.length };
    }, "Outlook draft");
  },

  outlook_event_correct: async (run, env) => {
    const gap = need(env, ...GRAPH_ENV, "VERIFY_GRAPH_USER", "VERIFY_GRAPH_RECIPIENT");
    if (gap) return skipped(gap);
    type GraphEvent = {
      subject?: string;
      start?: { dateTime?: string };
      end?: { dateTime?: string };
      attendees?: { emailAddress?: { address?: string } }[];
    };
    return pollChecked(async () => {
      const body = await graph<{ value?: GraphEvent[] }>(
        env,
        `${user(env)}/calendarView?startDateTime=2026-11-19T00:00:00Z&endDateTime=2026-11-22T00:00:00Z&$top=200&$select=subject,start,end,attendees`,
        { prefer: 'outlook.timezone="UTC"' },
      );
      const events = (body.value ?? []).filter((event) => (event.subject ?? "").includes(run));
      const event = events[0];
      if (!event) return null;
      const problems: string[] = [];
      // 15:00-15:30 in Oslo on 20 November 2026 is 14:00-14:30 UTC.
      const start = event.start?.dateTime ?? "";
      const end = event.end?.dateTime ?? "";
      if (!start.startsWith("2026-11-20T14:00")) problems.push(`starts ${start} UTC`);
      if (!end.startsWith("2026-11-20T14:30")) problems.push(`ends ${end} UTC`);
      const attendees = addresses(event.attendees);
      if (!attendees.includes(env.VERIFY_GRAPH_RECIPIENT!.toLowerCase())) {
        problems.push(`attendees ${attendees.join(", ") || "none"}`);
      }
      return { detail: `event "${event.subject}" ${start}-${end} UTC`, problems, count: events.length };
    }, "Outlook event");
  },

  outlook_contact_correct: async (run, env) => {
    const gap = need(env, ...GRAPH_ENV, "VERIFY_GRAPH_USER");
    if (gap) return skipped(gap);
    type GraphContact = {
      displayName?: string;
      givenName?: string;
      surname?: string;
      companyName?: string;
      emailAddresses?: { address?: string }[];
    };
    return pollChecked(async () => {
      const body = await graph<{ value?: GraphContact[] }>(
        env,
        `${user(env)}/contacts?$top=200&$select=displayName,givenName,surname,companyName,emailAddresses`,
      );
      const contacts = (body.value ?? []).filter((contact) =>
        [contact.displayName, `${contact.givenName ?? ""} ${contact.surname ?? ""}`].some((name) =>
          (name ?? "").includes(run),
        ),
      );
      const contact = contacts[0];
      if (!contact) return null;
      const problems: string[] = [];
      const emails = (contact.emailAddresses ?? []).map((entry) => (entry.address ?? "").toLowerCase());
      if (!emails.includes("halcyon.eval@bluefin.example")) problems.push(`email ${emails.join(", ") || "none"}`);
      if ((contact.companyName ?? "") !== "Bluefin Logistics") problems.push(`company ${contact.companyName ?? "none"}`);
      return { detail: `contact "${contact.displayName}"`, problems, count: contacts.length };
    }, "Outlook contact");
  },

  onedrive_file_correct: async (run, env) => {
    const gap = need(env, ...GRAPH_ENV, "VERIFY_GRAPH_USER");
    if (gap) return skipped(gap);
    return pollChecked(
      () => checkDriveFile(env, `${user(env)}/drive`, "Runbooks", run, "Eval file content."),
      "OneDrive file",
    );
  },

  sharepoint_file_correct: async (run, env) => {
    const gap = need(env, ...GRAPH_ENV, "VERIFY_GRAPH_SP_SITE_ID");
    if (gap) return skipped(gap);
    const drive = `/sites/${encodeURIComponent(env.VERIFY_GRAPH_SP_SITE_ID!)}/drive`;
    return pollChecked(
      () => checkDriveFile(env, drive, "Eval uploads", run, "Eval upload content."),
      "SharePoint file",
    );
  },

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
