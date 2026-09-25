---
"@opengeni/api-router": minor
"@opengeni/config": minor
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
"@opengeni/runtime": minor
"@opengeni/worker-bundle": minor
---

Add the optional Jev-backed `code_search` agent tool. It finds where something is implemented, configured or decided in the workspace in one call and returns verbatim, line-numbered passages with a coverage status. It is controlled by `OPENGENI_CODE_SEARCH_MODE` (`off` by default, `opt_in`, `default_on`, or `experiment` for a fixed per-session half), the `OPENGENI_JEV_*` settings, and a per-workspace `codeSearchEnabled` setting (`null` follows the deployment). Each session freezes its decision when it is created (`sessions.code_search_enabled`, rolling migration 0520, exposed as `codeSearchEnabled` on the session), and children keep their parent's, so later setting changes never add the tool to a running session's cached prompt; only the deployment switch-off and a workspace Off, and undoing them, reach running sessions. Each call records Jev usage per workspace. The Jev key stays on the server (API and worker processes) and never reaches a sandbox or Connected Machine, which only run allowlisted read-only ripgrep and file reads. Windows Connected Machines do not get the tool. `tool_search` now lists every tool the query names exactly before BM25 results.
