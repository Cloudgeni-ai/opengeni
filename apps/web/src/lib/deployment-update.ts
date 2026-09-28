// A different source revision does not imply an incompatible API. Never tear
// down a live browser handoff, draft or upload merely because a release rolled.
// The API contract guard remains responsible for incompatible clients.
export async function notifyDeploymentUpdate(
  deploymentRevision: string | undefined,
  bundleRevision: string,
): Promise<void> {
  if (!deploymentRevision || !bundleRevision || deploymentRevision === bundleRevision) return;
  const { toast } = await import("sonner");
  toast.info("OpenGeni update available", {
    id: "opengeni-deployment-update",
    description: "Reload when you’re ready to use the new version.",
    duration: Infinity,
    closeButton: true,
    action: {
      label: "Reload",
      onClick: () => window.location.reload(),
    },
  });
}
