import { isAbsolute } from "node:path";
import { parseKubernetesNodeSelectorJson, parseKubernetesTolerationsJson } from "@opengeni/config";
import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import { SandboxConfigError } from "../errors";
import { KubernetesSandboxClient } from "../kubernetes";
import { REPEATABLE_PORTABLE_TAR_WORKSPACE_CAPTURE, type ProviderRegistration } from "./types";

export const kubernetesProvider: ProviderRegistration = {
  backend: "kubernetes",
  exactResumeMode: "custom",
  instanceIdFields: ["podUid"],
  workspaceCapturePolicy: () => REPEATABLE_PORTABLE_TAR_WORKSPACE_CAPTURE,
  descriptor: CAPABILITY_DESCRIPTORS.kubernetes,
  validateCredentials(settings) {
    if (!settings.kubernetesImage.trim()) {
      throw new SandboxConfigError("kubernetes", "OPENGENI_KUBERNETES_IMAGE is required");
    }
    if (settings.kubernetesKubeconfig && !isAbsolute(settings.kubernetesKubeconfig)) {
      throw new SandboxConfigError(
        "kubernetes",
        "OPENGENI_KUBERNETES_KUBECONFIG must be an absolute path",
      );
    }
    const kubectlPath = settings.kubernetesKubectlPath.trim();
    if (kubectlPath.includes("/") && !isAbsolute(kubectlPath)) {
      throw new SandboxConfigError(
        "kubernetes",
        "OPENGENI_KUBERNETES_KUBECTL_PATH must be a command name or absolute path",
      );
    }
  },
  build({ settings, environment }) {
    return new KubernetesSandboxClient({
      image: settings.kubernetesImage,
      ...(settings.kubernetesNamespace ? { namespace: settings.kubernetesNamespace } : {}),
      ...(settings.kubernetesKubeconfig ? { kubeconfig: settings.kubernetesKubeconfig } : {}),
      ...(settings.kubernetesContext ? { context: settings.kubernetesContext } : {}),
      kubectlPath: settings.kubernetesKubectlPath,
      imagePullPolicy: settings.kubernetesImagePullPolicy,
      ...(settings.kubernetesServiceAccount
        ? { serviceAccountName: settings.kubernetesServiceAccount }
        : {}),
      automountServiceAccountToken: settings.kubernetesAutomountServiceAccountToken,
      ...(settings.kubernetesRuntimeClass
        ? { runtimeClassName: settings.kubernetesRuntimeClass }
        : {}),
      ...(settings.kubernetesPriorityClass
        ? { priorityClassName: settings.kubernetesPriorityClass }
        : {}),
      nodeSelector: parseKubernetesNodeSelectorJson(settings.kubernetesNodeSelectorJson),
      tolerations: parseKubernetesTolerationsJson(settings.kubernetesTolerationsJson),
      startupTimeoutSeconds: settings.kubernetesStartupTimeoutSeconds,
      cpuRequest: settings.kubernetesCpuRequest,
      cpuLimit: settings.kubernetesCpuLimit,
      memoryRequest: settings.kubernetesMemoryRequest,
      memoryLimit: settings.kubernetesMemoryLimit,
      ephemeralStorageRequest: settings.kubernetesEphemeralStorageRequest,
      ephemeralStorageLimit: settings.kubernetesEphemeralStorageLimit,
      workspaceSizeLimit: settings.kubernetesWorkspaceSizeLimit,
      workspacePersistence: "tar",
      env: environment,
    });
  },
};
