import { useEffect, useState } from "react";

/**
 * What the browser says about using the microphone here before anyone asks:
 * `blocked` when this page is not allowed to use it at all (an embedded frame
 * without microphone permission, such as an add-in in Office on the web),
 * `denied` when the person blocked it for this site, `unknown` when the browser
 * will ask when voice starts or cannot say.
 *
 * Browsers without a permissions-policy API (Firefox) report a frame without
 * microphone permission as `denied`; inside an embedded frame that is most
 * likely the host page's policy, which site settings can't change, so it counts
 * as `blocked` there.
 */
export type MicrophoneAccess = "unknown" | "blocked" | "denied";

type PermissionsPolicyLike = { allowsFeature?: (feature: string) => boolean };

export function useMicrophoneAccess(): MicrophoneAccess {
  const [blocked] = useState(microphoneBlockedByPage);
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    if (blocked) return;
    const permissions = typeof navigator === "undefined" ? undefined : navigator.permissions;
    if (typeof permissions?.query !== "function") return;
    let active = true;
    let status: PermissionStatus | null = null;
    const update = () => setDenied(status?.state === "denied");
    let query: Promise<PermissionStatus>;
    try {
      query = permissions.query({ name: "microphone" as PermissionName });
    } catch {
      return;
    }
    query.then(
      (result) => {
        if (!active) return;
        status = result;
        update();
        result.addEventListener("change", update);
      },
      // A browser that cannot query the microphone asks when voice starts.
      () => undefined,
    );
    return () => {
      active = false;
      status?.removeEventListener("change", update);
    };
  }, [blocked]);
  return blocked ? "blocked" : denied ? (isEmbedded() ? "blocked" : "denied") : "unknown";
}

function isEmbedded(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

function microphoneBlockedByPage(): boolean {
  if (typeof document === "undefined") return false;
  const policies = document as Document & {
    permissionsPolicy?: PermissionsPolicyLike;
    featurePolicy?: PermissionsPolicyLike;
  };
  const policy = policies.permissionsPolicy ?? policies.featurePolicy;
  try {
    return policy?.allowsFeature?.("microphone") === false;
  } catch {
    return false;
  }
}
