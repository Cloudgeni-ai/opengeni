import type {
  AppPackageInstallRequest,
  AppPackageInstallResponse,
  AppTemplate,
} from "@opengeni/sdk";

type Installer = {
  installAppPackage(
    workspaceId: string,
    request: AppPackageInstallRequest,
  ): Promise<AppPackageInstallResponse>;
};

/**
 * Adds a ready-made app: installs its package with one key per ready-made app,
 * so adding it again returns the same app, unless that app was archived, then
 * it's added fresh (each archived copy keys the next one). Used by the
 * Capabilities Ready-made tab and the Artifacts Apps tab.
 */
export async function installReadyMadeApp(
  client: Installer,
  workspaceId: string,
  template: Pick<AppTemplate, "key" | "package">,
): Promise<AppPackageInstallResponse> {
  let installed = await client.installAppPackage(workspaceId, {
    package: template.package,
    idempotencyKey: `ready-made:${template.key}`,
  });
  for (
    let hops = 0;
    installed.replayed && installed.app.status !== "active" && hops < 20;
    hops += 1
  ) {
    installed = await client.installAppPackage(workspaceId, {
      package: template.package,
      idempotencyKey: `ready-made:${template.key}:after:${installed.app.id}`,
    });
  }
  return installed;
}

/** Whether the app asks for tools, so whoever adds it connects them first. */
export function readyMadeAppNeedsTools(template: Pick<AppTemplate, "package">): boolean {
  const tools = (template.package as { tools?: unknown } | null)?.tools;
  return Array.isArray(tools) && tools.length > 0;
}
