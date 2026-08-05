# Maintenance release: migration 0172

OpenGeni 0.22.74 applies the immutable
`0172_retire_model_visible_github_token.sql` migration under the production
maintenance gate. The migration removes the model-visible `github_token` tool
from durable session selections and prevents older writers from restoring it.

The release must use the maintenance deployment path so serving workloads are
drained before the one-way migration and only the new runtime starts afterward.
The candidate schema contract, production backup gate, rollout health checks,
and live acceptance remain mandatory.
