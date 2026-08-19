---
---

Make Garage the default bundled S3 fixture for Compose, single-node Kubernetes, and local-k8s smoke. MinIO remains an explicit opt-in. The app stays on `s3-compatible`; cloud profiles stay Azure Blob / AWS S3 / GCS. Garage ignores PUT `If-None-Match`; uniqueness remains content-addressed keys plus Postgres identity.
