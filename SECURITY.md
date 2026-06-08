# Security Policy

## Reporting Vulnerabilities

Please report security issues through GitHub private vulnerability reporting for this repository instead of opening a public issue.

Include:

- Affected component or endpoint.
- Steps to reproduce.
- Expected and observed impact.
- Any relevant logs with secrets removed.

## Sensitive Data

Do not include API keys, tokens, private keys, cloud credentials, customer data, or production infrastructure details in issues, pull requests, logs, screenshots, or test fixtures.

## Local Development

OpenGeni runs agents that can execute tools in configured sandboxes. Review `.env` carefully before running live sessions, especially sandbox preparation profiles and `OPENGENI_SANDBOX_ENV_ALLOWLIST`.

The base API is workspace-scoped and resolves protected requests through an access grant. `managed` mode uses Better Auth for browser human auth and OpenGeni-owned API keys for product/API access. `configured` mode lets a self-hosted or embedded deployment use delegated bearer tokens or a deployment shared-key boundary. The deployment shared key uses `x-opengeni-access-key`; product API keys use `Authorization: Bearer`.

Before exposing OpenGeni beyond local development, choose the access mode intentionally, run the workspace-isolation/RLS checks, use a non-owner application DB role in production where possible, and put appropriate gateway rate limits and request size limits in front of public routes.

No model provider credentials are automatically exposed inside agent sandboxes. Only expose host credentials through explicit preparation profiles or allowlists, and prefer short-lived credentials.
