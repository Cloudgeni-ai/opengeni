---
name: checkov
description: Use Checkov to scan Terraform and infrastructure-as-code repositories for policy violations, explain findings, choose safe fixes, rerun scans, and prepare pull requests with remediations.
---

# Checkov

Use this skill when the user asks to scan Terraform or infrastructure-as-code for security, compliance, or best-practice issues.

## Workflow

1. Confirm the repository path before scanning. Repository resources are usually mounted under `/workspace/repos/<owner>/<repo>`.
2. Run Checkov from the repository root or the relevant Terraform subdirectory:

```bash
checkov -d . --framework terraform --compact
```

3. For a machine-readable result that is easier to inspect and summarize, write JSON to a temporary file:

```bash
checkov -d . --framework terraform -o json --output-file-path /tmp/checkov-results
```

4. Summarize the failed checks in plain language. Include the check ID, file, resource, and reason.
5. When the user asks for fixes, edit only the selected findings. Keep changes focused and preserve the existing Terraform style.
6. Validate after edits:

```bash
terraform fmt -recursive
terraform init -backend=false
terraform validate
checkov -d . --framework terraform --compact
```

7. If GitHub credentials are available, create a branch and draft pull request for the fix.

## Guardrails

- Do not run `terraform apply` unless the user explicitly asks for it.
- Prefer `terraform init -backend=false` for validation so remote state is not touched.
- Do not suppress Checkov findings unless the user asks for a suppression and the reason is documented in code.
- If provider credentials are missing, still run static checks and explain which validation steps could not be completed.
