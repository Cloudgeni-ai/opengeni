import {
  DEFAULT_FILE_RESOURCE_MOUNT_ROOT,
  type FileResourceRef,
  type ResourceRef,
} from "@opengeni/sdk";

/**
 * Stable identity for one logical file attachment.
 *
 * A file id alone is insufficient: callers may mount the same durable file at
 * multiple explicit paths. Keep this key byte-for-byte aligned with composer
 * draft/send deduplication so persistence and presentation agree about whether
 * two resources are the same attachment.
 */
export function fileResourceIdentity(resource: FileResourceRef): string {
  return `file:${resource.fileId}\u0000${
    resource.mountPath ?? `${DEFAULT_FILE_RESOURCE_MOUNT_ROOT}/${resource.fileId}`
  }`;
}

export function resourceIdentity(resource: ResourceRef): string {
  return resource.kind === "file" ? fileResourceIdentity(resource) : JSON.stringify(resource);
}
