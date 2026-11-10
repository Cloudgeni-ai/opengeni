#!/usr/bin/env bun
/**
 * Public synthetic catalogs and multi-need scenarios for the harness:
 *
 *   bun scripts/tool-discovery-eval/fixtures/synthetic-catalog.ts --out <dir>
 *
 * writes `large/` (about 1,350 tools: one product server with CRUD-style
 * families and near-duplicate names, plus a dozen common integrations) and
 * `small/` (50 tools: mail, calendar and chat), each with `catalog.json` and
 * `scenarios.json`. Registry ids carry a connection digest and a hyphen, so
 * model names are `mcp_<digest>__<leaf>` aliases and tool_list groups are
 * opaque, as in a real deployment.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { largeScenarios, smallScenarios } from "./synthetic-scenarios";

const hex = (s: string, n = 20) => createHash("sha256").update(s).digest("hex").slice(0, n);
const reg = (label: string) => `conn-${hex(label)}`;
const h = (s: string) => parseInt(hex(s, 8), 16);

type Entry = { server: string; tool: string; description: string; inputSchema: unknown };
const product: Entry[] = [];
const uuid = { type: "string", format: "uuid" };
const schema = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
});

// ---------- product server ----------
const P = reg("fieldops");
type Fam = { name: string; label: string; plural: string; scope: "project" | "organization"; extra?: string[] };
const fam = (name: string, label: string, plural: string, scope: Fam["scope"], extra: string[] = []): Fam => ({ name, label, plural, scope, extra });
const families: Fam[] = [
  fam("projects", "project", "projects", "organization", ["archive", "restore", "list_history", "get_summary", "set_status", "duplicate", "export"]),
  fam("project_members", "project member", "project members", "project", ["add", "remove", "set_role", "list_by_user"]),
  fam("project_locations", "project location", "project locations", "project", ["move", "list_tree"]),
  fam("project_documents", "project document", "project documents", "project", ["link_file", "unlink_file", "move", "get_download_url"]),
  fam("organizations", "organization", "organizations", "organization", ["get_central_approval", "get_settings", "update_settings", "list_trades"]),
  fam("organization_members", "organization member", "organization members", "organization", ["invite", "remove", "set_role"]),
  fam("checklists", "checklist", "checklists", "project", ["import_template", "list_project_tree", "create_checkpoint", "update_checkpoint", "delete_checkpoint", "link_deviation", "unlink_deviation", "link_file", "create_report", "get_report", "create_folder", "move_item", "rename_item", "duplicate_item", "list_unresolved_checkpoints", "add_comment"]),
  fam("form_templates", "form template", "form templates", "organization", ["list_project_checklist_tree", "list_organization_checklist_tree", "list_system_checklist_tree", "publish", "duplicate", "create_folder"]),
  fam("forms", "form", "forms", "project", ["submit", "reopen", "export"]),
  fam("form_submissions", "form submission", "form submissions", "project", ["approve", "reject", "export"]),
  fam("form_submission_drafts", "form submission draft", "form submission drafts", "project", ["promote_to_deviation", "promote_to_change_order", "promote_to_job_safety_analysis"]),
  fam("handbooks", "handbook", "handbooks", "organization", ["list_by_project", "publish", "archive"]),
  fam("handbook_revisions", "handbook revision", "handbook revisions", "organization", ["import_template", "publish", "compare"]),
  fam("routine_templates", "routine template", "routine templates", "organization", ["list_published", "list_importable", "publish"]),
  fam("routines", "routine", "routines", "organization", ["assign", "acknowledge", "list_by_handbook"]),
  fam("deviations", "deviation", "deviations", "project", ["set_status", "set_responsible", "link_file", "unlink_file", "list_files", "close", "reopen", "export", "list_history", "add_comment", "list_comments"]),
  fam("change_orders", "change order", "change orders", "project", ["submit", "approve", "reject", "set_status", "export", "link_file"]),
  fam("orders", "order", "orders", "project", ["submit", "cancel", "add_line", "remove_line", "export"]),
  fam("purchase_orders", "purchase order", "purchase orders", "organization", ["send", "receive", "cancel", "add_line"]),
  fam("invoices", "invoice", "invoices", "organization", ["send", "mark_paid", "credit", "list_unpaid", "export", "send_reminder"]),
  fam("invoice_lines", "invoice line", "invoice lines", "organization", []),
  fam("customers", "customer", "customers", "organization", ["merge", "list_contacts", "export"]),
  fam("contacts", "contact", "contacts", "organization", ["merge"]),
  fam("suppliers", "supplier", "suppliers", "organization", ["list_price_lists", "import_price_list"]),
  fam("price_lists", "price list", "price lists", "organization", ["import", "compare"]),
  fam("products", "product", "products", "organization", ["import", "list_by_supplier"]),
  fam("employees", "employee", "employees", "organization", ["deactivate", "list_certificates", "set_manager"]),
  fam("time_entries", "time entry", "time entries", "project", ["approve", "reject", "list_by_employee", "submit_week", "export", "bulk_update"]),
  fam("timesheets", "timesheet", "timesheets", "organization", ["approve", "reopen", "lock_period"]),
  fam("payroll_exports", "payroll export", "payroll exports", "organization", ["get_download_url", "send"]),
  fam("absences", "absence", "absences", "organization", ["approve", "reject"]),
  fam("certificates", "certificate", "certificates", "organization", ["list_expiring", "link_file"]),
  fam("courses", "course", "courses", "organization", ["enroll", "complete"]),
  fam("equipment", "equipment item", "equipment", "organization", ["assign", "list_by_project", "retire"]),
  fam("equipment_inspections", "equipment inspection", "equipment inspections", "organization", ["complete", "list_due"]),
  fam("hse_rounds", "HSE round", "HSE rounds", "project", ["schedule", "list_due"]),
  fam("hse_round_executions", "HSE round execution", "HSE round executions", "project", ["complete", "link_deviation"]),
  fam("risk_assessments", "risk assessment", "risk assessments", "organization", ["publish", "list_hazards", "create_hazard"]),
  fam("job_safety_analyses", "job safety analysis", "job safety analyses", "project", ["sign", "list_hazards", "add_hazard", "export"]),
  fam("meetings", "meeting", "meetings", "project", ["add_participant", "remove_participant", "create_minutes", "send_invitation"]),
  fam("meeting_minutes", "meeting minutes", "meeting minutes", "project", ["publish", "export"]),
  fam("tasks", "task", "tasks", "project", ["assign", "complete", "reopen", "list_by_assignee", "add_comment"]),
  fam("documents", "document", "documents", "organization", ["move", "get_download_url", "share", "list_versions"]),
  fam("folders", "folder", "folders", "organization", ["move", "list_tree"]),
  fam("files", "file", "files", "organization", ["create_upload", "complete_upload", "get_download_url"]),
  fam("photos", "photo", "photos", "project", ["create_upload", "tag", "list_by_location"]),
  fam("drawings", "drawing", "drawings", "project", ["create_revision", "list_revisions", "add_markup"]),
  fam("bim_models", "BIM model", "BIM models", "project", ["create_version", "list_versions", "retry_processing", "get_element_properties"]),
  fam("bim_viewpoints", "BIM viewpoint", "BIM viewpoints", "project", ["link_deviation", "link_checkpoint", "link_hse_round_execution"]),
  fam("calculations", "calculation", "calculations", "project", ["duplicate", "recalculate", "export", "lock"]),
  fam("calculation_library", "library item", "library items", "organization", ["author_package", "author_post", "capture_package", "publish"]),
  fam("tariffs", "tariff", "tariffs", "organization", ["list_items", "search_items"]),
  fam("warehouses", "warehouse", "warehouses", "organization", ["list_stock", "adjust_stock", "transfer_stock"]),
  fam("vehicles", "vehicle", "vehicles", "organization", ["assign", "log_trip"]),
  fam("notifications", "notification", "notifications", "organization", ["mark_read", "send"]),
  fam("reports", "report", "reports", "organization", ["run", "schedule", "get_download_url"]),
  fam("dashboards", "dashboard", "dashboards", "organization", ["get_widgets", "add_widget"]),
  fam("activity", "activity event", "activity events", "organization", ["list_recent", "list_by_project"]),
  fam("audit_log", "audit log entry", "audit log entries", "organization", ["export"]),
  fam("webhooks", "webhook", "webhooks", "organization", ["test", "rotate_secret"]),
  fam("api_keys", "API key", "API keys", "organization", ["rotate", "revoke"]),
  fam("users", "user", "users", "organization", ["get_me", "update_profile"]),
  fam("roles", "role", "roles", "organization", ["set_permissions"]),
  fam("integrations", "integration", "integrations", "organization", ["connect", "disconnect", "sync"]),
  fam("comments", "comment", "comments", "project", ["react", "resolve"]),
  fam("tags", "tag", "tags", "organization", ["apply", "remove"]),
  fam("trades", "trade", "trades", "organization", []),
  fam("subcontractors", "subcontractor", "subcontractors", "project", ["invite", "list_documents", "check_central_approval"]),
  fam("inspections", "inspection", "inspections", "project", ["schedule", "complete", "create_report"]),
  fam("punch_items", "punch item", "punch items", "project", ["close", "assign", "link_photo"]),
  fam("rfis", "request for information", "requests for information", "project", ["answer", "close"]),
  fam("submittals", "submittal", "submittals", "project", ["approve", "reject", "resubmit"]),
];
const verbs = ["list", "get", "create", "update", "delete", "search"];
const scopeText = (f: Fam) => (f.scope === "project" ? "in a project" : "in the current organization");
const params = (f: Fam, verb: string) => {
  const id = `${f.label.replace(/[^a-z]+/gi, "_").toLowerCase().replace(/^_|_$/g, "")}Id`
    .replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const base: Record<string, unknown> = f.scope === "project" ? { projectId: uuid } : {};
  if (["list", "search"].includes(verb) || verb.startsWith("list"))
    return schema({ ...base, query: { type: "string" }, cursor: { type: "string" } }, f.scope === "project" ? ["projectId"] : []);
  if (verb === "create")
    return schema({ ...base, name: { type: "string" }, description: { type: "string" } }, [...(f.scope === "project" ? ["projectId"] : []), "name"]);
  return schema({ ...base, [id]: uuid, ...(verb === "update" ? { name: { type: "string" }, description: { type: "string" } } : {}) }, [id]);
};
const describe = (f: Fam, verb: string): string => {
  const L = f.label, Pl = f.plural, s = scopeText(f);
  switch (verb) {
    case "list": return `List ${Pl} ${s}. Optional query uses shared search matching. One cursor page at a time.`;
    case "get": return `Get one ${L} with its details.`;
    case "create": return `Create a ${L} ${s}.`;
    case "update": return `Update a ${L}: name, description and other editable fields.`;
    case "delete": return `Delete a ${L}. This cannot be undone.`;
    case "search": return `Search ${Pl} ${s} by name and content.`;
    case "archive": return `Archive a ${L} while keeping its history.`;
    case "restore": return `Restore an archived ${L}.`;
    case "list_history": return `List the change history of a ${L}.`;
    case "export": return `Export ${Pl} as a spreadsheet or PDF.`;
    case "import": return `Import ${Pl} from a file.`;
    case "duplicate": return `Duplicate a ${L}.`;
    case "set_status": return `Set the status of a ${L}.`;
    case "set_responsible": return `Set the responsible person for a ${L}.`;
    case "link_file": return `Claim an uploaded file and attach it to a ${L}. Upload it first with files.create_upload.`;
    case "unlink_file": return `Remove an attached file from a ${L}.`;
    case "list_files": return `List files attached to a ${L}.`;
    case "add_comment": return `Add a comment to a ${L}.`;
    case "list_comments": return `List comments on a ${L}.`;
    case "assign": return `Assign a ${L} to a person.`;
    case "approve": return `Approve a submitted ${L}.`;
    case "reject": return `Reject a submitted ${L} with a reason.`;
    case "submit": return `Submit a ${L} for approval.`;
    case "close": return `Close a ${L}.`;
    case "reopen": return `Reopen a closed ${L}.`;
    case "get_summary": return `Get a short summary of a ${L}: counts, status and recent activity.`;
    case "get_download_url": return `Get a short-lived download URL for a ${L}.`;
    case "list_by_project": return `List ${Pl} owned by a project. Optional query uses shared search matching.`;
    case "add": return `Add a person as a ${L}.`;
    case "remove": return `Remove a ${L}.`;
    case "set_role": return `Change the role of a ${L}.`;
    // product-specific
    case "import_template": return f.name === "checklists"
      ? "Import a system, organization or project checklist template or template folder into a folder of the project checklist tree. Find sourceItemId with form_templates.list_system_checklist_tree, list_organization_checklist_tree or list_project_checklist_tree."
      : "Import a published routine template into a handbook revision. Find templateRevisionId with routine_templates.list_importable.";
    case "list_project_tree": return "List the full checklist tree for a project: folders and checklists. Optional query uses shared search matching.";
    case "list_project_checklist_tree": return "List the project checklist-template tree. Optional query uses shared search matching.";
    case "list_organization_checklist_tree": return "List the organization checklist-template tree. Optional query uses shared search matching.";
    case "list_system_checklist_tree": return "List the system checklist-template tree that can be imported into checklists.";
    case "list_published": return "List published routine templates available to import into handbook drafts.";
    case "list_importable": return "List published routine templates importable into a handbook revision, with the templateRevisionId to pass to handbook_revisions.import_template.";
    case "get_central_approval": return "Look up a company's central approval in the public register. Without organizationNumber it uses the current company's own number.";
    case "list_unpaid": return "List invoices that are sent but not paid, optionally for one customer.";
    case "send_reminder": return "Send a payment reminder for an overdue invoice to the customer.";
    case "list_by_employee": return "List time entries for one employee in a date range.";
    case "submit_week": return "Submit an employee's time entries for one week for approval.";
    case "create_upload": return `Start an upload: returns an upload URL and a pending fileId to claim with the target's link_file tool.`;
    case "create_minutes": return "Create the minutes document for a meeting.";
    case "send_invitation": return "Send calendar invitations for a meeting to its participants.";
    case "list_recent": return "List recent activity across the organization in a date range.";
    default: {
      const words = verb.replace(/_/g, " ");
      return `${words[0]!.toUpperCase()}${words.slice(1)} for a ${L}.`;
    }
  }
};
const commonExtras = ["archive", "restore", "list_history", "export", "import", "add_comment", "list_comments", "link_file", "unlink_file", "list_files", "set_status", "assign", "duplicate", "get_summary", "bulk_update", "set_responsible", "list_by_project"];
for (const f of families) {
  // Most families get the CRUD set; a stable subset lacks search/delete, as real APIs do.
  const own = verbs.filter((v) => !(v === "search" && h(f.name + v) % 3 === 0) && !(v === "delete" && h(f.name + v) % 5 === 0));
  // Many families also share common verbs, which makes names near-duplicates across families.
  const shared = commonExtras.filter((v) => !(f.extra ?? []).includes(v) && h(f.name + "/" + v) % 17 < 6);
  for (const verb of [...own, ...(f.extra ?? []), ...shared])
    product.push({ server: P, tool: `${f.name}.${verb}`, description: describe(f, verb), inputSchema: params(f, verb) });
}

// ---------- common integrations ----------
type Ext = { label: string; tools: [string, string][] };
const crud = (res: string, plural: string, label: string, ops = ["list", "get", "create", "update", "delete"]): [string, string][] =>
  ops.map((op) => [
    `${op}_${op === "list" ? plural : res}`,
    op === "list" ? `List ${label}s.` : `${op[0]!.toUpperCase()}${op.slice(1)} a ${label}.`,
  ]);
const exts: Ext[] = [
  { label: "github", tools: [
    ...crud("pull_request", "pull_requests", "GitHub pull request"), ["merge_pull_request", "Merge a pull request."], ["request_reviewers", "Request reviewers on a pull request."],
    ["get_pull_request_status", "Get the combined CI status of a pull request's head commit."], ["list_check_runs", "List check runs (CI jobs) for a commit or pull request."],
    ["list_workflow_runs", "List GitHub Actions workflow runs."], ["rerun_workflow", "Re-run a workflow run."], ["get_workflow_run_logs", "Download logs of a workflow run."],
    ...crud("issue", "issues", "GitHub issue"), ["add_issue_comment", "Comment on a GitHub issue or pull request."], ["search_code", "Search code across repositories."],
    ["get_file_contents", "Get a file's contents from a repository."], ["create_or_update_file", "Create or update a file in a repository."], ["create_branch", "Create a branch."],
    ["list_branches", "List branches."], ["list_commits", "List commits."], ["get_commit", "Get a commit."], ["create_release", "Create a release."], ["list_releases", "List releases."],
    ["list_repositories", "List repositories."], ["get_repository", "Get a repository."], ["fork_repository", "Fork a repository."], ["list_labels", "List labels."], ["add_labels", "Add labels to an issue or pull request."],
    ["list_pull_request_files", "List files changed in a pull request."], ["create_pull_request_review", "Submit a pull request review."], ["list_pull_request_reviews", "List reviews on a pull request."],
    ["search_issues", "Search GitHub issues and pull requests."], ["list_notifications", "List GitHub notifications."], ["list_deployments", "List deployments."], ["create_deployment", "Create a deployment."],
    ["list_secrets", "List repository secret names."], ["list_collaborators", "List repository collaborators."], ["update_pull_request_branch", "Update a pull request branch with its base."],
  ] },
  { label: "linear", tools: [
    ["save_issue", "Create or update a Linear issue. If id is provided, updates the existing issue; otherwise creates a new one."], ["get_issue", "Get a Linear issue."], ["list_issues", "List Linear issues with filters."],
    ["save_comment", "Create or update a comment on a Linear issue, project or document."], ["list_comments", "List comments on a Linear issue."], ["list_projects", "List Linear projects."], ["save_project", "Create or update a Linear project."],
    ["list_teams", "List Linear teams."], ["list_users", "List Linear users."], ["list_cycles", "List cycles for a team."], ["list_issue_labels", "List issue labels."], ["create_issue_label", "Create an issue label."],
    ["list_issue_statuses", "List workflow states for a team."], ["get_document", "Get a Linear document."], ["save_document", "Create or update a Linear document."], ["list_documents", "List Linear documents."],
    ["search_documentation", "Search Linear's documentation."], ["list_milestones", "List project milestones."], ["save_milestone", "Create or update a milestone."], ["get_status_updates", "List project status updates."],
    ["save_status_update", "Post a project status update."], ["list_initiatives", "List initiatives."], ["save_initiative", "Create or update an initiative."], ["prepare_file_upload", "Prepare a file upload for an issue or comment."],
  ] },
  { label: "sentry", tools: [
    ["search_issues", "Search for grouped issues in Sentry, for example is:unresolved."], ["get_issue_details", "Get details for one Sentry issue."], ["update_issue", "Resolve, ignore or assign a Sentry issue."],
    ["add_issue_note", "Add a comment to a Sentry issue's activity feed."], ["search_errors", "Count and aggregate Sentry error events."], ["search_logs", "Search Sentry logs."], ["search_traces", "Search Sentry traces and spans."],
    ["find_organizations", "List Sentry organizations."], ["find_projects", "List Sentry projects."], ["find_releases", "List releases."], ["find_teams", "List teams."], ["get_trace_details", "Get one trace."],
    ["get_event_attachment", "Download an event attachment."], ["create_project", "Create a Sentry project."], ["create_dsn", "Create a client key (DSN)."], ["find_dsns", "List client keys."], ["analyze_issue_with_seer", "Root-cause an issue with Seer."],
    ["get_sentry_resource", "Get any Sentry resource by URL."], ["whoami", "Show the authenticated Sentry user."], ["list_alert_rules", "List alert rules."], ["create_alert_rule", "Create an alert rule."],
  ] },
  { label: "slack", tools: [
    ["slack_send_message", "Send a message to a Slack channel or thread."], ["slack_search_messages", "Search Slack messages."], ["slack_list_channels", "List Slack channels."], ["slack_read_channel", "Read recent messages in a channel."],
    ["slack_read_thread", "Read a thread."], ["slack_add_reaction", "Add an emoji reaction."], ["slack_upload_file", "Upload a file to a channel."], ["slack_download_file", "Download a shared file."], ["slack_get_user", "Get a Slack user."],
    ["slack_list_users", "List Slack users."], ["slack_schedule_message", "Schedule a message."], ["slack_update_message", "Edit a message."], ["slack_delete_message", "Delete a message."], ["slack_create_channel", "Create a channel."],
  ] },
  { label: "gmail", tools: [
    ["send_message", "Send a new email immediately from the connected Gmail account."], ["create_draft", "Create an email draft."], ["update_draft", "Update a draft."], ["send_draft", "Send a draft."], ["list_drafts", "List drafts."],
    ["search_threads", "Search Gmail threads with Gmail search syntax."], ["get_thread", "Get a Gmail thread with its messages."], ["get_message", "Get one email message."], ["reply_to_message", "Reply to an email."], ["forward_message", "Forward an email."],
    ["list_labels", "List Gmail labels."], ["create_label", "Create a label."], ["modify_message_labels", "Add or remove labels on messages."], ["batch_modify_messages", "Add or remove labels on up to 1000 messages."], ["trash_message", "Move a message to trash."],
    ["get_attachment", "Download an email attachment."], ["list_filters", "List filters."], ["create_filter", "Create a filter."], ["get_profile", "Get the mailbox profile."], ["list_history", "List mailbox changes since a history id."],
    ["mark_as_read", "Mark messages as read."], ["archive_thread", "Archive a thread."], ["get_vacation_settings", "Get vacation responder settings."], ["update_vacation_settings", "Update vacation responder settings."],
  ] },
  { label: "calendar", tools: [
    ["list_events", "List Google Calendar events in a time range."], ["get_event", "Get one calendar event."], ["create_event", "Create a calendar event and invite attendees."], ["update_event", "Update a calendar event."],
    ["delete_event", "Delete a calendar event."], ["find_free_time", "Find free time for a set of attendees."], ["list_calendars", "List calendars."], ["respond_to_event", "Accept or decline an invitation."], ["quick_add_event", "Create an event from a sentence."],
    ["list_event_instances", "List instances of a recurring event."], ["move_event", "Move an event to another calendar."], ["get_freebusy", "Query free/busy information."],
  ] },
  { label: "drive", tools: [
    ["search_files", "Search Google Drive files."], ["get_file_metadata", "Get file metadata."], ["download_file", "Download a file."], ["upload_file", "Upload a file to Drive."], ["create_document", "Create a Google Doc."],
    ["create_spreadsheet", "Create a Google Sheet."], ["update_document", "Edit a Google Doc."], ["read_spreadsheet", "Read cells from a Sheet."], ["update_spreadsheet", "Write cells in a Sheet."], ["share_file", "Share a file with people."],
    ["list_permissions", "List who can access a file."], ["create_folder", "Create a Drive folder."], ["move_file", "Move a file."], ["copy_file", "Copy a file."], ["delete_file", "Delete a file."], ["list_comments", "List comments on a file."],
    ["add_comment", "Comment on a file."], ["export_file", "Export a Google Doc as PDF or DOCX."], ["list_revisions", "List file revisions."], ["list_shared_drives", "List shared drives."],
  ] },
  { label: "grafana", tools: [
    ["query_loki_logs", "Query logs with LogQL."], ["query_prometheus", "Run a PromQL query."], ["list_prometheus_metric_names", "List metric names."], ["list_loki_label_names", "List log label names."],
    ["search_dashboards", "Search dashboards."], ["get_dashboard_by_uid", "Get a dashboard."], ["update_dashboard", "Create or update a dashboard."], ["get_dashboard_panel_queries", "Get panel queries."],
    ["list_alert_rules", "List alert rules."], ["get_alert_rule_by_uid", "Get an alert rule."], ["create_alert_rule", "Create an alert rule."], ["update_alert_rule", "Update an alert rule."], ["delete_alert_rule", "Delete an alert rule."],
    ["list_contact_points", "List contact points."], ["list_datasources", "List data sources."], ["get_datasource_by_uid", "Get a data source."], ["query_tempo_traces", "Search traces in Tempo."], ["get_trace", "Get one trace."],
    ["list_incidents", "List incidents."], ["create_incident", "Create an incident."], ["add_activity_to_incident", "Add a note to an incident."], ["list_oncall_schedules", "List on-call schedules."], ["get_current_oncall_users", "Who is on call now."],
    ["list_annotations", "List annotations."], ["create_annotation", "Create an annotation."], ["find_error_pattern_logs", "Find elevated error patterns in logs."], ["find_slow_requests", "Find slow requests in traces."],
    ["list_teams", "List Grafana teams."], ["list_users_by_org", "List users."], ["generate_deeplink", "Generate a deeplink to Explore or a dashboard."], ["get_sift_analysis", "Get a Sift investigation."], ["list_pyroscope_profile_types", "List profile types."],
    ["fetch_pyroscope_profile", "Fetch a CPU or memory profile."], ["list_silences", "List alert silences."], ["create_silence", "Silence alerts."], ["get_assertions", "Get entity assertions."], ["search_folders", "Search dashboard folders."],
    ["create_folder", "Create a dashboard folder."], ["list_notification_policies", "List notification policies."], ["update_notification_policy", "Update notification policy."],
  ] },
  { label: "cloudflare", tools: [
    ["workers_list", "List Workers."], ["workers_get_worker", "Get a Worker."], ["workers_get_worker_code", "Get a Worker's code."], ["kv_namespaces_list", "List KV namespaces."], ["kv_namespace_create", "Create a KV namespace."],
    ["d1_databases_list", "List D1 databases."], ["d1_database_create", "Create a D1 database."], ["d1_database_query", "Run SQL on a D1 database."], ["r2_buckets_list", "List R2 buckets."], ["r2_bucket_create", "Create an R2 bucket."],
    ["dns_records_list", "List DNS records for a zone."], ["dns_record_create", "Create a DNS record."], ["dns_record_update", "Update a DNS record."], ["dns_record_delete", "Delete a DNS record."], ["zones_list", "List zones."],
    ["accounts_list", "List accounts."], ["set_active_account", "Set the active account."], ["observability_query", "Query Workers logs and metrics."], ["search_cloudflare_documentation", "Search Cloudflare docs."],
    ["hyperdrive_configs_list", "List Hyperdrive configs."], ["pages_projects_list", "List Pages projects."], ["pages_deployments_list", "List Pages deployments."],
  ] },
  { label: "crm", tools: [
    ...crud("company", "companies", "CRM company"), ...crud("person", "people", "CRM person"), ...crud("deal", "deals", "CRM deal"), ...crud("note", "notes", "CRM note"), ...crud("task", "tasks", "CRM task"),
    ["search_records", "Search CRM records."], ["add_record_to_list", "Add a record to a list."], ["list_lists", "List CRM lists."], ["list_list_entries", "List entries in a list."], ["update_list_entry", "Update a list entry."],
    ["list_attribute_definitions", "List attribute definitions."], ["list_workspace_members", "List workspace members."], ["get_record_activity", "Get activity for a record."], ["create_comment", "Comment on a record."], ["list_meetings", "List meetings linked to records."],
  ] },
  { label: "billing", tools: [
    ...crud("customer", "customers", "billing customer"), ...crud("invoice", "invoices", "billing invoice"), ["finalize_invoice", "Finalize a draft invoice."], ["send_invoice", "Email an invoice to the customer."],
    ["void_invoice", "Void an invoice."], ["pay_invoice", "Pay an invoice."], ...crud("subscription", "subscriptions", "subscription"), ["cancel_subscription", "Cancel a subscription."], ...crud("price", "prices", "price"),
    ...crud("product", "products", "billing product"), ["list_payment_intents", "List payments."], ["create_refund", "Refund a payment."], ["list_refunds", "List refunds."], ["get_balance", "Get the account balance."],
    ["list_payouts", "List payouts."], ["create_payment_link", "Create a payment link."], ["list_disputes", "List disputes."], ["update_dispute", "Respond to a dispute."], ["create_coupon", "Create a coupon."], ["list_coupons", "List coupons."],
    ["search_documentation", "Search billing docs."],
  ] },
  { label: "email-sending", tools: [
    ["send_email", "Send a single transactional email to one or more recipients."], ["send_batch_emails", "Send up to 100 emails."], ["list_emails", "List sent emails."], ["get_email", "Get a sent email."],
    ["create_broadcast", "Create a broadcast."], ["send_broadcast", "Send a broadcast."], ["list_broadcasts", "List broadcasts."], ["list_domains", "List sending domains."], ["create_domain", "Add a domain."], ["verify_domain", "Verify a domain."],
    ["list_contacts", "List audience contacts."], ["create_contact", "Create a contact."], ["update_contact", "Update a contact."], ["remove_contact", "Remove a contact."], ["list_audiences", "List audiences."], ["create_audience", "Create an audience."],
    ["list_api_keys", "List API keys."], ["create_api_key", "Create an API key."], ["list_segments", "List segments."], ["add_contact_to_segment", "Add a contact to a segment."], ["list_templates", "List email templates."], ["create_template", "Create an email template."],
  ] },
];
const integrations = new Map<string, Entry[]>();
for (const e of exts) {
  const server = reg(e.label);
  const props = schema({ query: { type: "string" } });
  integrations.set(
    e.label,
    e.tools.map(([tool, description]) => ({ server, tool, description, inputSchema: props })),
  );
}
const outIndex = process.argv.indexOf("--out");
const outDir = outIndex < 0 ? undefined : process.argv[outIndex + 1];
if (!outDir) {
  console.error("Required: --out <directory>");
  process.exit(2);
}
/** A scenario reference to a tool as `server.tool`, which the catalog resolves. */
const ref = (label: string, tool: string) => `${label === "fieldops" ? P : reg(label)}.${tool}`;
const sets = {
  large: { tools: [...product, ...[...integrations.values()].flat()], scenarios: largeScenarios(ref) },
  small: {
    tools: ["gmail", "calendar", "slack"].flatMap((label) => integrations.get(label)!),
    scenarios: smallScenarios(ref),
  },
};
for (const [name, set] of Object.entries(sets)) {
  const seen = new Set<string>();
  for (const t of set.tools) {
    const key = `${t.server}/${t.tool}`;
    if (seen.has(key)) throw new Error(`duplicate ${key}`);
    seen.add(key);
  }
  await Bun.write(join(outDir, name, "catalog.json"), JSON.stringify({ tools: set.tools }));
  await Bun.write(join(outDir, name, "scenarios.json"), JSON.stringify(set.scenarios, null, 2));
  console.log(`${name}: ${set.tools.length} tools, ${set.scenarios.length} scenarios`);
}
