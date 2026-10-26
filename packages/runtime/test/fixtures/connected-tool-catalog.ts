import { DRIVE_EXTRA_TOOLS } from "../../src/drive-mcp";
import { GITHUB_REST_MCP_TOOLS } from "../../src/github-rest-mcp";
import { GMAIL_REST_MCP_TOOLS } from "../../src/gmail-rest-mcp";
import { GOOGLE_CALENDAR_REST_MCP_TOOLS } from "../../src/google-calendar-rest-mcp";
import { withAccountLine } from "../../src/tool-discovery-ranking";

/** One searchable tool: its model name is `${source}__${name}`. */
export type CatalogTool = {
  source: string;
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
};

const from = (
  source: string,
  tools: readonly { name: string; description?: string; inputSchema?: unknown }[],
): CatalogTool[] =>
  tools.map((t) => ({
    source,
    name: t.name,
    description: t.description ?? "",
    ...(t.inputSchema ? { inputSchema: t.inputSchema as Record<string, unknown> } : {}),
  }));

const written = (source: string, tools: readonly (readonly [string, string])[]): CatalogTool[] =>
  tools.map(([name, description]) => ({ source, name, description }));

/** Outlook Mail in the shape the OpenAPI compiler gives Microsoft Graph operations. */
export const OUTLOOK_MAIL_TOOLS = written("mcp__outlook", [
  [
    "me_listmessages",
    "Get the messages in the signed-in user's mailbox (including the Deleted Items and Clutter folders). GET /me/messages. Read-only.",
  ],
  [
    "me_getmessages",
    "Retrieve the properties and relationships of a message object. GET /me/messages/{message-id}. Read-only.",
  ],
  [
    "me_mailfolders_listmessages",
    "Get all the messages in the specified user's mailbox, or those messages in a specified folder in the mailbox. GET /me/mailFolders/{mailFolder-id}/messages. Read-only.",
  ],
  [
    "me_sendmail",
    "Send the message specified in the request body using either JSON or MIME format. POST /me/sendMail. Changes external state. Your tool permissions determine whether review is needed.",
  ],
]);

export const GMAIL_TOOLS = from("mcp__gmail", GMAIL_REST_MCP_TOOLS);
export const CALENDAR_TOOLS = from("mcp__calendar", GOOGLE_CALENDAR_REST_MCP_TOOLS);

/**
 * One of several connected accounts of a connector: each tool description
 * starts with the account line the runtime adds when a turn has several.
 */
export const withAccount = (
  tools: readonly CatalogTool[],
  source: string,
  account: string,
): CatalogTool[] =>
  tools.map((t) => ({ ...t, source, description: withAccountLine(account, t.description) }));

/**
 * A realistic pool of about 170 tools from several connected integrations
 * (mail, code hosting, file storage, cloud hosting, a newsletter service, an
 * error tracker, an issue tracker, team chat) and first-party tools, with
 * descriptions written the way those servers write them. It has no calendar,
 * weather, travel or ticketing tools, so vague requests for those must find
 * nothing here.
 */
export const CONNECTED_TOOL_CATALOG: CatalogTool[] = [
  ...GMAIL_TOOLS,
  ...OUTLOOK_MAIL_TOOLS,
  ...from("mcp__github", GITHUB_REST_MCP_TOOLS),
  ...from("mcp__drive", DRIVE_EXTRA_TOOLS),
  ...written("mcp__cloud", [
    ["accounts_list", "List all accounts in your cloud hosting provider."],
    ["set_active_account", "Set the active account for the following tool calls."],
    ["kv_namespaces_list", "List all of the kv namespaces in your cloud account."],
    ["kv_namespace_create", "Create a new kv namespace in your cloud account."],
    ["kv_namespace_delete", "Delete a kv namespace in your cloud account."],
    ["kv_namespace_get", "Get details of a kv namespace in your cloud account."],
    ["kv_namespace_update", "Update the title of a kv namespace in your cloud account."],
    ["workers_list", "List all workers in your cloud account."],
    ["workers_get_worker", "Get the details of a worker script."],
    ["workers_get_worker_code", "Get the source code of a worker script."],
    ["r2_buckets_list", "List object storage buckets in your cloud account."],
    ["r2_bucket_create", "Create a new object storage bucket in your cloud account."],
    ["r2_bucket_get", "Get details about a specific object storage bucket."],
    ["r2_bucket_delete", "Delete an object storage bucket."],
    ["d1_databases_list", "List all of the SQL databases in your cloud account."],
    ["d1_database_create", "Create a new SQL database in your cloud account."],
    ["d1_database_get", "Get a SQL database in your cloud account."],
    ["d1_database_query", "Query a SQL database in your cloud account."],
    ["d1_database_delete", "Delete a SQL database in your cloud account."],
    ["hyperdrive_configs_list", "List database connection pool configurations in your account."],
    ["search_docs", "Search the hosting provider's developer documentation."],
  ]),
  ...written("mcp__newsletter", [
    ["send_email", "Send an email to one or more recipients."],
    ["list_emails", "List emails sent from your account, newest first."],
    ["get_email", "Get the content and delivery status of one sent email."],
    ["cancel_email", "Cancel a scheduled email before it is sent."],
    ["create_broadcast", "Create a broadcast: one email sent to an entire segment."],
    ["list_broadcasts", "List broadcasts with their status and schedule."],
    ["get_broadcast", "Get one broadcast by ID."],
    ["update_broadcast", "Update a draft broadcast's subject, content or segment."],
    ["send_broadcast", "Send (or schedule) an existing broadcast by ID."],
    ["remove_broadcast", "Remove a draft broadcast."],
    ["create_template", "Create a new email template with HTML content and variables."],
    ["list_templates", "List email templates."],
    ["get_template", "Get one email template and its variables."],
    ["update_template", "Update an email template's HTML or variables."],
    ["remove_template", "Remove an email template."],
    ["create_contact", "Create a contact in an audience."],
    ["list_contacts", "List contacts in an audience."],
    ["get_contact", "Get one contact by ID or email address."],
    ["remove_contact", "Remove a contact from an audience."],
    ["create_segment", "Create a segment of contacts for broadcasts."],
    ["list_segments", "List segments."],
    ["list_domains", "List sending domains and their verification status."],
    ["verify_domain", "Start verifying a sending domain's DNS records."],
    [
      "connect_to_editor",
      "Show agent presence in the dashboard editor while you edit a broadcast or template.",
    ],
  ]),
  ...written("mcp__errors", [
    ["whoami", "Identify the authenticated user in the error tracker."],
    ["find_organizations", "Find organizations that the user has access to in the error tracker."],
    ["find_teams", "Find teams in an organization in the error tracker."],
    ["find_projects", "Find projects in the error tracker."],
    ["find_releases", "Find releases in the error tracker."],
    ["get_issue_details", "Get detailed information about a specific error issue."],
    ["get_trace_details", "Get an overview of one trace: its spans, timing and errors."],
    ["search_events", "Search error events and performance spans with a natural language query."],
    ["search_issues", "Search grouped error issues with a natural language query."],
    ["update_issue", "Update an error issue's status or assignee."],
    ["create_project", "Create a new project in the error tracker."],
    ["create_dsn", "Create an additional client key for a project."],
  ]),
  ...written("mcp__issues", [
    ["list_issues", "List issues in the workspace, filtered by team, project, assignee or state."],
    ["get_issue", "Retrieve detailed information about an issue by ID."],
    ["save_issue", "Create or update an issue."],
    ["list_comments", "List comments on a specific issue."],
    ["create_comment", "Create a comment on a specific issue."],
    ["delete_comment", "Delete a comment on an issue."],
    ["list_projects", "List projects in the workspace."],
    ["get_project", "Retrieve details of a specific project."],
    ["save_project", "Create or update a project."],
    ["list_teams", "List teams in the workspace."],
    ["get_team", "Retrieve details of a specific team."],
    ["list_users", "List users in the workspace."],
    ["get_user", "Retrieve details of a specific user."],
    ["list_cycles", "List the cycles of a team."],
    ["list_issue_labels", "List the issue labels of a team or the workspace."],
    ["list_issue_statuses", "List the issue statuses of a team."],
    ["list_documents", "List documents in the workspace."],
    ["get_document", "Retrieve a document by ID or slug."],
    ["list_templates", "List issue templates."],
    ["search_documentation", "Search the issue tracker's own product documentation."],
  ]),
  ...written("mcp__chat", [
    ["post_message", "Post a message to a channel or thread."],
    ["list_channels", "List public channels in the workspace."],
    ["read_channel", "Read the recent messages of a channel."],
    ["read_thread", "Read the replies in a message thread."],
    ["search_messages", "Search messages across the channels you can see."],
    ["add_reaction", "Add an emoji reaction to a message."],
    ["get_user_profile", "Get a person's profile and status."],
    ["upload_file", "Upload a file to a channel."],
  ]),
  ...written("opengeni", [
    ["run_on", "Run a one-off op on a specific enrolled machine; prefer the shell for this session's own machine."],
    ["knowledge_search", "Find Knowledge by subject or entity name."],
    ["knowledge_get", "Open one Knowledge entry with its full text and revision."],
    ["knowledge_save", "Save a reusable fact, decision or requirement as Knowledge."],
    ["notify_user", "Notify the person who owns this session: it goes to their inbox and, when new, to their phone."],
    ["skill_search", "Find Skills by what they help with."],
    ["skill_read", "Read a Skill's instructions."],
    ["schedule_create", "Create a scheduled task that runs a prompt on a schedule."],
    ["schedule_list", "List this workspace's scheduled tasks."],
    ["schedule_pause", "Pause a scheduled task."],
    ["session_list", "List recent sessions in this workspace."],
    ["session_send_message", "Send a message to another agent session."],
    ["secret_search", "Find saved secrets and their ready references."],
    ["generate_image", "Generate or edit an image from a prompt."],
    ["site_publish", "Publish a Site from the workspace."],
  ]),
];
