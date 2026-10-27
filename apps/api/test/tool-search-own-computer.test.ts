import { describe, expect, test } from "bun:test";
import { ToolSearchIndex } from "../../../packages/runtime/src/tool-discovery-ranking";
import { defaultToolSearchPool } from "./helpers/default-tool-search-pool";

// Ranking against the real default search pool (the tools a search can
// actually return): requests about the person's own computer, and
// neighbouring requests that only mention a computer, phone or machine.
const short = (name: string) => name.slice(name.lastIndexOf("__") + 2);
const MACHINE_TOOLS = new Set([
  "sandboxes_list",
  "run_on",
  "sandbox_swap",
  "sandbox_attach",
  "interaction_discover",
  "computer_targets",
  "computer_observe",
  "computer_act",
  "computer_clipboard",
  "computer_lifecycle",
]);

describe("tool search for the person's own computer", async () => {
  const pool = await defaultToolSearchPool();
  const index = new ToolSearchIndex(pool);
  const top = (query: string, limit: number) =>
    index.rank(query, limit).map((tool) => short(tool.name));

  test("the pool holds only tools a search can return", () => {
    const names = pool.map((tool) => tool.name);
    expect(names).toContain("opengeni__sandboxes_list");
    expect(names).toContain("interaction__computer_observe");
    for (const firstRequestTool of [
      "opengeni__goal_set",
      "opengeni__command_read",
      "opengeni__wait_for_input",
      "opengeni__sandbox_file_publish",
      "interaction__browser_open",
      "interaction__computer_open",
    ])
      expect(names).not.toContain(firstRequestTool);
  });

  test("a request naming several operations on a laptop's files ranks the connected machines first", () => {
    expect(
      top(
        "discover connected laptop machines and read list move files in Downloads folder on user's computer",
        1,
      ),
    ).toEqual(["sandboxes_list"]);
  });

  test.each([
    "run a command on the user's laptop",
    "open the Desktop folder on my Mac",
    "list machines the user has connected",
    "use my Windows PC",
    "clean up my desktop on my laptop",
    "control the screen of my Mac",
    "open an app on my computer",
    "work on the person's own computer",
  ])("%s reaches a machine tool first", (query) => {
    expect(MACHINE_TOOLS.has(top(query, 1)[0]!), query).toBe(true);
  });

  test.each([
    ["get a download URL for a workspace file", "files_get_download_url"],
    ["download a file from the workspace", "files_get_download_url"],
    ["read a workspace file", "files_get_download_url"],
    ["upload a file to the workspace", "site_files_upload"],
    ["list workspace files", "site_files_list"],
    ["take a screenshot of a web page", "browser_screenshot"],
    ["create a schedule", "scheduled_tasks_create"],
    ["list scheduled tasks", "scheduled_tasks_list"],
    ["find integrations to connect", "capability_catalog_search"],
    ["run code in an Excel workbook on the person's Mac", "excel_run"],
    ["take a screenshot of the screen in the current computer session", "computer_observe"],
    // Mentioning a computer, phone or machine does not make a request about
    // reaching one.
    ["download the file to my computer", "files_get_download_url"],
    ["upload an image from my computer to the Site", "site_files_upload"],
    ["list the browser downloads on my computer", "browser_downloads"],
    ["notify me on my phone when the job on my machine finishes", "notify_user"],
    ["save the browser download to my computer", "browser_download_save"],
    ["get the download link for the PC installer file", "files_get_download_url"],
    ["create a project for the machine learning pipeline", "project_create"],
    ["save the Mac login password as a secret", "secret_save"],
    ["publish the site about desktop wallpapers", "site_publication_update"],
    ["list my GitHub repositories on my computer", "github_repositories_list"],
  ])("%s keeps its best match", (query, expected) => {
    expect(top(query, 1)).toEqual([expected]);
  });

  test.each(["order state machine", "Desktop folder in the workspace files"])(
    "%s does not reach a machine tool first",
    (query) => {
      expect(MACHINE_TOOLS.has(top(query, 1)[0]!), query).toBe(false);
    },
  );

  // Every operation a query names counts, so in a long multi-verb request a
  // later verb can take first place; the tool for the request still has to
  // stay among the first results.
  test.each([
    ["fetch the page, read its text, click the login button and send the form", "browser_read"],
    ["find, read and update the knowledge entry", "knowledge_search"],
    ["list, create, update or delete scheduled tasks", "scheduled_tasks_list"],
  ])("%s keeps %s in the first three", (query, expected) => {
    expect(top(query, 3)).toContain(expected);
  });
  test("a multi-verb secrets request stays on secret tools first", () => {
    expect(top("view, edit, save and delete secrets", 1)[0]).toStartWith("secret_");
  });
});
