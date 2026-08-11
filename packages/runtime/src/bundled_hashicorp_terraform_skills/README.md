# Bundled infrastructure agent skills

The deployment-default bundle is vendored from [github.com/hashicorp/agent-skills](https://github.com/hashicorp/agent-skills): a flat merge of

- `terraform/code-generation/skills/`
- `terraform/module-generation/skills/`

plus repo-local infrastructure skills, so the OpenAI Agents SDK `Skills` capability can mount one `LocalDir` at the workspace `.agents` root. Each immediate subdirectory is a skill (contains `SKILL.md`). The Azure Verified Modules guidance is intentionally excluded from this always-enabled bundle; it is maintained as the immutable opt-in entry in `../bundled_skill_library/azure-verified-modules/`.

Repo-local skills:

- `checkov` — guidance for running Checkov in the sandbox shell, summarizing findings, fixing selected issues, rerunning validation, and preparing a PR.
- `social-media-marketing` — guidance for scheduled social media analysis using OpenGeni social connector MCP tools and optional document-base knowledge.

- `UPSTREAM_GIT_SHA` — commit the tree was copied from
- `LICENSE` — upstream MPL-2.0

**To refresh upstream Terraform skills:** fetch `hashicorp/agent-skills`, copy those two `skills/` directory contents into this folder (sibling skill dirs), omit `azure-verified-modules` from this default bundle, and update `UPSTREAM_GIT_SHA`. Do not remove repo-local skills such as `checkov` during refresh. Update the curated library entry separately and immutably when its reviewed version changes.
