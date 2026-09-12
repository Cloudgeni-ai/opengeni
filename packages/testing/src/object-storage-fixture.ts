export const OBJECT_STORAGE_FIXTURE_BUCKET = "opengeni-files";

export const GARAGE_FIXTURE_ACCESS_KEY_ID = "GK0123456789abcdef0123456789abcdef";
export const GARAGE_FIXTURE_SECRET_ACCESS_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
export const GARAGE_FIXTURE_RPC_SECRET =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const GARAGE_FIXTURE_S3_PORT = 3900;
export const GARAGE_FIXTURE_S3_PROVIDER = "Other";
export const GARAGE_FIXTURE_SANDBOX_ENDPOINT = "http://garage:3900";
export const GARAGE_FIXTURE_IMAGE =
  "dxflrs/garage:v2.3.0@sha256:866bd13ed2038ba7e7190e840482bc27234c4afaf77be8cfa439ae088c1e4690";
// The release publisher pushes the same build to Docker Hub and Quay:
// https://github.com/minio/mc/blob/7394ce0dd2a80935aded936b09fa12cbb3cb8096/docker-buildx.sh#L25-L32
// Pin the multi-platform index, not an architecture-specific child manifest.
export const GARAGE_FIXTURE_MC_IMAGE =
  "quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727";

export const MINIO_FIXTURE_ACCESS_KEY_ID = "minioadmin";
export const MINIO_FIXTURE_SECRET_ACCESS_KEY = "minioadmin";
export const MINIO_FIXTURE_S3_PROVIDER = "Minio";
export const MINIO_FIXTURE_SANDBOX_ENDPOINT = "http://minio:9000";
