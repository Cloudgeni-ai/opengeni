import { getSettings } from "@opengeni/config";
import { createObjectStorage, prepareObjectStorageProvider } from "../src";

const backend = process.argv[2]!;
const settings = {
  ...getSettings(),
  objectStorageBackend:
    backend === "disabled"
      ? ("s3-compatible" as const)
      : (backend as "s3-compatible" | "aws-s3" | "azure-blob" | "gcs"),
  objectStorageEndpoint: backend === "disabled" ? undefined : "http://127.0.0.1:1",
  objectStorageAccessKeyId: backend === "disabled" ? undefined : "test-key",
  objectStorageSecretAccessKey: backend === "disabled" ? undefined : "test-secret",
  objectStorageAzureAccountName: "testaccount",
  objectStorageAzureAccountKey: Buffer.alloc(32).toString("base64"),
  objectStorageGcsProjectId: "test-project",
};
function loaded() {
  const modules = Object.keys(require.cache);
  return [
    ["aws-s3", /@aws-sdk\/client-s3/],
    ["azure-blob", /@azure\/storage-blob/],
    ["gcs", /@google-cloud\/storage/],
  ]
    .filter(([, pattern]) => modules.some((name) => (pattern as RegExp).test(name)))
    .map(([name]) => name);
}
const before = loaded();
prepareObjectStorageProvider(settings);
const prepared = loaded();
const storage = createObjectStorage(settings);
console.log(
  JSON.stringify({ before, prepared, constructed: loaded(), backend: storage?.backend ?? null }),
);
