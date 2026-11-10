/**
 * Multi-need scenarios over the synthetic catalogs. A task asks for several
 * things; each need lists every tool that serves it. Each task is searched in
 * three styles agents use: `packed` (keywords, semicolon-separated), `prose`
 * (one plain clause per need, semicolon-separated) and `sentence` (the user's
 * request as one sentence, no separators). Each need is also a single-need
 * search of its own. Tasks tagged `split:holdout` were written before any
 * selection change was tuned and are reported separately.
 */
type Ref = (label: string, tool: string) => string;
type Need = { query: string; accept: [string, string][] };
type Task = {
  id: string;
  split: "dev" | "holdout";
  needs: Need[];
  queries: Partial<Record<"packed" | "prose" | "sentence", string>>;
};

const need = (query: string, ...accept: [string, string][]): Need => ({ query, accept });
const f = (tool: string): [string, string] => ["fieldops", tool];

function scenarios(tasks: Task[], ref: Ref) {
  return tasks.flatMap((task) => {
    const needs = task.needs.map((n) => n.accept.map(([label, tool]) => ref(label, tool)));
    const split = `split:${task.split}`;
    return [
      ...Object.entries(task.queries).map(([style, query]) => ({
        id: `${task.id}-${style}`,
        queries: [query],
        needs,
        tags: [split, needs.length > 1 ? "multi-need" : "single-need", `style:${style}`],
        source: "synthetic task",
      })),
      ...(task.needs.length > 1 ? task.needs : []).map((n, i) => ({
        id: `${task.id}-need${i + 1}`,
        queries: [n.query],
        needs: [needs[i]!],
        tags: [split, "single-need"],
        source: "synthetic task, one need",
      })),
    ];
  });
}

const LARGE: Task[] = [
  {
    id: "T1",
    split: "dev",
    needs: [
      need(
        "list checklist templates",
        f("form_templates.list_project_checklist_tree"),
        f("form_templates.list_organization_checklist_tree"),
        f("form_templates.list_system_checklist_tree"),
      ),
      need("import a checklist template into a project", f("checklists.import_template")),
      need("list a project's handbooks", f("handbooks.list_by_project")),
      need(
        "list routine templates for handbooks",
        f("routine_templates.list_published"),
        f("routine_templates.list_importable"),
      ),
    ],
    queries: {
      packed:
        "checklists list templates create project; handbooks list project organization routines central approval",
      prose:
        "list checklist templates; import a checklist template into a project; list a project's handbooks; list routine templates for handbooks",
      sentence:
        "I need to create project checklists from the company's checklist templates and see which handbooks and routines the project has",
    },
  },
  {
    id: "T2",
    split: "dev",
    needs: [
      need("create a deviation in a project", f("deviations.create")),
      need("upload a photo file", f("files.create_upload"), f("photos.create_upload")),
      need("attach an uploaded file to a deviation", f("deviations.link_file")),
      need("set the responsible person on a deviation", f("deviations.set_responsible")),
    ],
    queries: {
      packed: "deviations create project; upload photo attach deviation; responsible",
      prose:
        "create a deviation in a project; upload a photo file; attach the photo to the deviation; set the responsible person on the deviation",
      sentence:
        "Register a deviation on the project with a photo attached and make Per responsible for fixing it",
    },
  },
  {
    id: "T3",
    split: "dev",
    needs: [
      need("search unresolved Sentry issues", ["sentry", "search_issues"]),
      need("create a Linear issue", ["linear", "save_issue"]),
      need("post a message in a Slack channel", ["slack", "slack_send_message"]),
    ],
    queries: {
      packed: "sentry issues unresolved; linear create issue; slack post message channel",
      prose:
        "search unresolved Sentry issues; create a Linear issue; post a message in a Slack channel",
      sentence:
        "Find the new unresolved errors in Sentry, file a Linear issue for the worst one and tell the team in Slack",
    },
  },
  {
    id: "T4",
    split: "dev",
    needs: [
      need("create a GitHub pull request", ["github", "create_pull_request"]),
      need("request reviewers on a pull request", ["github", "request_reviewers"]),
      need(
        "check CI status of a pull request",
        ["github", "get_pull_request_status"],
        ["github", "list_check_runs"],
      ),
    ],
    queries: {
      packed: "github pull request create; reviewers request; ci checks status",
      prose:
        "create a GitHub pull request; request reviewers on the pull request; check the CI status of the pull request",
      sentence: "Open a pull request for my branch, ask Kari to review it and tell me when CI is green",
    },
  },
  {
    id: "T5",
    split: "dev",
    needs: [
      need("rename a project", f("projects.update")),
      need("add a member to a project", f("project_members.add"), f("project_members.create")),
      need("archive a project", f("projects.archive")),
    ],
    queries: {
      packed: "projects update name; project members add; projects archive",
      prose: "rename a project; add a member to a project; archive an old project",
      sentence:
        "Rename the Storgata project, add Ola to its team and archive last year's pilot project",
    },
  },
  {
    id: "T6",
    split: "dev",
    needs: [
      need(
        "list unpaid invoices for a customer",
        f("invoices.list_unpaid"),
        f("invoices.list"),
        f("invoices.search"),
      ),
      need("get a customer's details", f("customers.get")),
      need("send an email from Gmail", ["gmail", "send_message"], ["gmail", "create_draft"]),
    ],
    queries: {
      packed: "invoices unpaid customer list; customers get; gmail send email",
      prose:
        "list unpaid invoices for a customer; get the customer's contact details; send an email from Gmail",
      sentence:
        "Check which invoices Byggmester AS has not paid yet and email their contact a friendly reminder",
    },
  },
  {
    id: "T7",
    split: "dev",
    needs: [
      need("list the members of a project", f("project_members.list")),
      need("create a calendar event with attendees", ["calendar", "create_event"]),
      need("create a meeting in a project", f("meetings.create")),
    ],
    queries: {
      packed: "project members list; calendar event create; meetings create project",
      prose:
        "list the members of a project; create a calendar event with attendees; create a meeting in the project",
      sentence:
        "Set up a kickoff meeting next Tuesday with everyone on the project team and put it in their calendars",
    },
  },
  {
    id: "T8",
    split: "dev",
    needs: [
      need(
        "list time entries for an employee this week",
        f("time_entries.list_by_employee"),
        f("time_entries.list"),
      ),
      need("approve time entries", f("time_entries.approve"), f("timesheets.approve")),
      need("create a payroll export", f("payroll_exports.create")),
    ],
    queries: {
      packed: "time entries employee week list; approve time entries; payroll export create",
      prose:
        "list an employee's time entries this week; approve the time entries; create a payroll export",
      sentence: "Go through Per's hours for this week, approve them and run the payroll export",
    },
  },
  {
    id: "T9",
    split: "holdout",
    needs: [
      need(
        "list routine templates that can be imported into a handbook",
        f("routine_templates.list_importable"),
        f("routine_templates.list_published"),
      ),
      need("import a routine template into a handbook revision", f("handbook_revisions.import_template")),
    ],
    queries: {
      packed: "routine templates importable list; handbook revision import template",
      prose:
        "list the routine templates I can import; import a routine template into the handbook revision",
      sentence: "Add the standard fire safety routine from our templates to the new handbook revision",
    },
  },
  {
    id: "T10",
    split: "holdout",
    needs: [
      need("find a deviation by its title", f("deviations.search"), f("deviations.list")),
      need("comment on a deviation", f("deviations.add_comment")),
      need("close a deviation", f("deviations.close")),
    ],
    queries: {
      packed: "deviations search title; deviation add comment; deviation close",
      prose: "find the deviation about the broken railing; add a comment to it; close the deviation",
      sentence:
        "The broken railing deviation is fixed now, write a short note on it saying so and close it",
    },
  },
  {
    id: "T11",
    split: "holdout",
    needs: [
      need(
        "search error logs",
        ["grafana", "query_loki_logs"],
        ["grafana", "find_error_pattern_logs"],
      ),
      need("create an incident", ["grafana", "create_incident"]),
      need("find who is on call", ["grafana", "get_current_oncall_users"]),
    ],
    queries: {
      packed: "loki error logs query; grafana incident create; oncall users current",
      prose: "search the error logs for the checkout service; open an incident; find who is on call now",
      sentence:
        "Checkout is throwing errors, look at the logs, open an incident and tell me who is on call",
    },
  },
  {
    id: "T12",
    split: "holdout",
    needs: [
      need("list a customer's payments", ["billing", "list_payment_intents"]),
      need("refund a payment", ["billing", "create_refund"]),
      need(
        "email the customer",
        ["email-sending", "send_email"],
        ["gmail", "send_message"],
        ["gmail", "create_draft"],
      ),
    ],
    queries: {
      packed: "billing payments list customer; refund create; send email customer",
      prose: "list the customer's payments; refund the last payment; email the customer about the refund",
      sentence: "Refund Hansen's last card payment and send them an email confirming it",
    },
  },
  {
    id: "T13",
    split: "holdout",
    needs: [
      need("list equipment inspections that are due", f("equipment_inspections.list_due")),
      need("complete an equipment inspection", f("equipment_inspections.complete")),
    ],
    queries: {
      packed: "equipment inspections due list; equipment inspection complete",
      prose: "list the equipment inspections that are due; mark an inspection as completed",
      sentence: "Which equipment inspections are overdue? Mark the lift inspection as done",
    },
  },
  {
    id: "T14",
    split: "holdout",
    needs: [
      need("list DNS zones", ["cloudflare", "zones_list"]),
      need("create a DNS record", ["cloudflare", "dns_record_create"]),
    ],
    queries: {
      packed: "cloudflare zones list; dns record create",
      prose: "list my Cloudflare zones; add a DNS record to a zone",
      sentence: "Point status.example.com at our new server with a DNS record in Cloudflare",
    },
  },
  {
    id: "T15",
    split: "holdout",
    needs: [
      need("upload a new drawing revision", f("drawings.create_revision")),
      need("add markup to a drawing", f("drawings.add_markup")),
    ],
    queries: {
      packed: "drawings revision create; drawing markup add",
      prose: "upload a new revision of a drawing; add a markup to the drawing",
      sentence: "Put the architect's new floor plan revision in and mark where the extra outlet goes",
    },
  },
  {
    id: "T16",
    split: "holdout",
    needs: [
      need("find a customer", f("customers.list"), f("customers.get")),
      need("create an invoice", f("invoices.create")),
      need("send an invoice to the customer", f("invoices.send")),
    ],
    queries: {
      packed: "customers search; invoices create; invoice send",
      prose: "find the customer; create an invoice for the customer; send the invoice",
      sentence: "Invoice Nordbygg for the extra work last week and send it to them",
    },
  },
];

const g = (tool: string): [string, string] => ["gmail", tool];
const c = (tool: string): [string, string] => ["calendar", tool];
const s = (tool: string): [string, string] => ["slack", tool];

const SMALL: Task[] = [
  {
    id: "S1",
    split: "holdout",
    needs: [
      need("search my email", g("search_threads")),
      need("reply to an email", g("reply_to_message")),
    ],
    queries: {
      packed: "gmail search threads; reply to message",
      sentence: "Find Kari's email about the invoice and reply that we will pay on Friday",
    },
  },
  {
    id: "S2",
    split: "holdout",
    needs: [
      need("find free time for attendees", c("find_free_time"), c("get_freebusy")),
      need("create a calendar event", c("create_event"), c("quick_add_event")),
      need("post a Slack message", s("slack_send_message")),
    ],
    queries: {
      packed: "calendar free time; calendar event create; slack send message",
      sentence: "Find a time next week when Ola and I are both free, book it and tell #team on Slack",
    },
  },
  {
    id: "S3",
    split: "holdout",
    needs: [
      need("send an email", g("send_message"), g("create_draft")),
      need("update a calendar event", c("update_event")),
    ],
    queries: {
      packed: "gmail send email; calendar event update",
      sentence: "Email the agenda to the attendees and add it to the description of tomorrow's meeting",
    },
  },
  {
    id: "S4",
    split: "holdout",
    needs: [
      need("read a Slack channel", s("slack_read_channel"), s("slack_search_messages")),
    ],
    queries: {
      packed: "slack channel read messages",
      sentence: "What did people say in #release today?",
    },
  },
  {
    id: "S5",
    split: "holdout",
    needs: [
      need("find a calendar event", c("list_events"), c("get_event")),
      need("accept an invitation", c("respond_to_event")),
    ],
    queries: {
      packed: "calendar events list; respond to event invitation",
      sentence: "Accept Per's invitation for tomorrow",
    },
  },
  {
    id: "S6",
    split: "holdout",
    needs: [
      need("search my email", g("search_threads")),
      need("archive emails", g("archive_thread"), g("batch_modify_messages")),
    ],
    queries: {
      packed: "gmail search newsletters; archive threads",
      sentence: "Archive all the newsletters in my inbox",
    },
  },
  {
    id: "S7",
    split: "holdout",
    needs: [
      need("download an email attachment", g("get_attachment")),
      need("upload a file to Slack", s("slack_upload_file")),
    ],
    queries: {
      packed: "gmail attachment download; slack upload file",
      sentence: "Take the report.pdf from Lise's email and share it in #finance",
    },
  },
  {
    id: "S8",
    split: "holdout",
    needs: [
      need("set an out-of-office reply", g("update_vacation_settings")),
      need("create a calendar event", c("create_event"), c("quick_add_event")),
    ],
    queries: {
      packed: "gmail vacation responder update; calendar event create",
      sentence: "I'm away Monday to Friday next week: turn on my out-of-office and block the days",
    },
  },
  {
    id: "S9",
    split: "holdout",
    needs: [
      need("find a Slack user", s("slack_list_users"), s("slack_get_user")),
      need("send a Slack message", s("slack_send_message")),
    ],
    queries: {
      packed: "slack users find; slack send message",
      sentence: "Send Kari a Slack message that the build is fixed",
    },
  },
  {
    id: "S10",
    split: "holdout",
    needs: [
      need("find a calendar event", c("list_events"), c("get_event")),
      need("delete a calendar event", c("delete_event")),
    ],
    queries: {
      packed: "calendar events list; delete event",
      sentence: "Cancel Thursday's standup",
    },
  },
];

export const largeScenarios = (ref: Ref) => scenarios(LARGE, ref);
export const smallScenarios = (ref: Ref) => scenarios(SMALL, ref);
