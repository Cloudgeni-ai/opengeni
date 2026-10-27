import { describe, expect, test } from "bun:test";
import { ToolSearchIndex } from "../../../packages/runtime/src/tool-discovery-ranking";
import { defaultToolSearchPool } from "./helpers/default-tool-search-pool";

// Ranking against the real default tool pool: requests about the person's own
// computer must reach the machine tools in the first search, and neighbouring
// file, download, browser and schedule requests must keep their best match.
const short = (name: string) => name.slice(name.lastIndexOf("__") + 2);
const MACHINE_TOOLS = new Set([
  "sandboxes_list",
  "run_on",
  "sandbox_swap",
  "sandbox_attach",
  "interaction_discover",
  "computer_open",
  "computer_targets",
  "computer_observe",
  "computer_act",
]);

describe("tool search for the person's own computer", async () => {
  const index = new ToolSearchIndex(await defaultToolSearchPool());
  const top = (query: string, limit: number) =>
    index.rank(query, limit).map((tool) => short(tool.name));

  test("a request naming several operations on a laptop's files finds the connected machines first", () => {
    expect(
      top(
        "discover connected laptop machines and read list move files in Downloads folder on user's computer",
        2,
      ),
    ).toEqual(["sandboxes_list", "interaction_discover"]);
    expect(top("list files in the Downloads folder on the user's laptop", 3)).toContain(
      "sandboxes_list",
    );
    expect(top("find the user's connected machine", 1)).toEqual(["sandboxes_list"]);
  });

  test.each([
    "organize files in my Downloads folder on my computer",
    "access the user's Mac",
    "run a command on the user's laptop",
    "move files on the user's computer",
    "sort the Downloads folder on my laptop into pictures and documents",
    "open the Desktop folder on my Mac",
    "read a file on my PC",
    "do this on my computer",
    "work on the person's own computer",
    "use my Windows PC",
    "check disk space on my laptop",
    "rename photos in my Pictures folder on my computer",
  ])("%s reaches a machine tool first", (query) => {
    expect(MACHINE_TOOLS.has(top(query, 1)[0]!), query).toBe(true);
  });

  test.each([
    ["get a download URL for a workspace file", "files_get_download_url"],
    ["download a file from the workspace", "files_get_download_url"],
    ["read a workspace file", "files_get_download_url"],
    ["publish a file so the user can open it", "sandbox_file_publish"],
    ["upload a file to the workspace", "site_files_upload"],
    ["open a website in a browser", "browser_open"],
    ["open the user's own Chrome browser", "browser_open"],
    ["take a screenshot of a web page", "browser_screenshot"],
    ["create a schedule", "scheduled_tasks_create"],
    ["find integrations to connect", "capability_catalog_search"],
    ["run code in an Excel workbook on the person's Mac", "excel_run"],
    ["take a screenshot of the screen in the current computer session", "computer_observe"],
  ])("%s keeps its best match", (query, expected) => {
    expect(top(query, 1)).toEqual([expected]);
  });
});
