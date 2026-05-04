# Bundled HashiCorp Terraform agent skills

Vendored from [github.com/hashicorp/agent-skills](https://github.com/hashicorp/agent-skills): a flat merge of

- `terraform/code-generation/skills/`
- `terraform/module-generation/skills/`

so the OpenAI Agents SDK `Skills` capability can mount one `LocalDir` at the workspace `.agents` root. Each immediate subdirectory is a skill (contains `SKILL.md`).

- `UPSTREAM_GIT_SHA` — commit the tree was copied from
- `LICENSE` — upstream MPL-2.0

**To refresh:** fetch `hashicorp/agent-skills`, copy those two `skills/` directory contents into this folder (sibling skill dirs), and update `UPSTREAM_GIT_SHA`.
