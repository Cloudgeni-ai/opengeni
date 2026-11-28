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
 * Adds a ready-made app: installs its package with one key per ready-made app.
 * Install keys belong to the person and the package, so the same person adding
 * the same version again gets the app they added, unless they archived it,
 * then it's added fresh (each archived copy keys the next one). Someone else,
 * or a newer version of the template, adds a new copy. Used by the Apps
 * page's Ready-made list.
 */
export async function installReadyMadeApp(
  client: Installer,
  workspaceId: string,
  template: Pick<AppTemplate, "key" | "package">,
  demoData?: boolean,
): Promise<AppPackageInstallResponse> {
  const demo = demoData === undefined ? {} : { demoData };
  let installed = await client.installAppPackage(workspaceId, {
    package: template.package,
    ...demo,
    idempotencyKey: `ready-made:${template.key}`,
  });
  for (
    let hops = 0;
    installed.replayed && installed.app.status !== "active" && hops < 20;
    hops += 1
  ) {
    installed = await client.installAppPackage(workspaceId, {
      package: template.package,
      ...demo,
      idempotencyKey: `ready-made:${template.key}:after:${installed.app.id}`,
    });
  }
  return installed;
}
