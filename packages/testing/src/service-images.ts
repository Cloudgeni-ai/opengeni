/**
 * Immutable multi-architecture images used by required integration gates.
 *
 * Keep the human-readable version tag for auditability and the manifest-list
 * digest for byte identity across amd64 and arm64 runners.
 */
export const TEST_SERVICE_IMAGES = {
  pgvectorPg16:
    "pgvector/pgvector:pg16@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb",
  pgvectorPg17:
    "pgvector/pgvector:pg17@sha256:d2ef61f42ef767baa5a1475393303cc235bcd92febd9d7014eddb48b41f3bad0",
  nats: "nats:2.10.29-alpine@sha256:b83efabe3e7def1e0a4a31ec6e078999bb17c80363f881df35edc70fcb6bb927",
  temporal:
    "temporalio/auto-setup:1.28@sha256:d4cdc015d667ab5ccc3c6d1221a8792f4603c62378313db9391e47f0cb367305",
  minio:
    "minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e",
  minioClient:
    "minio/mc:RELEASE.2025-08-13T08-35-41Z@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727",
} as const;
