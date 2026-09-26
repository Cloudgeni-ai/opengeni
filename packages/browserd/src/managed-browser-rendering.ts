/** Controller-owned launch policy. Public BrowserSession requests never choose
 * compositor mode; an existing seat changes only through operator opt-in. */
export type ManagedHeadedSoftwareRenderingPolicy =
  | "disabled"
  | "allocated_linux"
  | "operator_enabled";

export function resolveManagedHeadedSoftwareRenderingPolicy(
  setting: string | undefined,
  computerEnvironmentMode: "existing" | "isolated_linux",
  platform: NodeJS.Platform,
): ManagedHeadedSoftwareRenderingPolicy {
  if (setting !== undefined && setting !== "true" && setting !== "false") {
    throw new Error("OPENGENI_BROWSERD_MANAGED_HEADED_SOFTWARE_RENDERING is invalid");
  }
  if (setting === "false") return "disabled";
  if (platform !== "linux") {
    if (setting === "true") {
      throw new Error("managed headed software rendering supports Linux only");
    }
    return "disabled";
  }
  if (setting === "true") return "operator_enabled";
  return computerEnvironmentMode === "isolated_linux" ? "allocated_linux" : "disabled";
}

export function managedChromiumSoftwareLaunchArguments(input: {
  policy: ManagedHeadedSoftwareRenderingPolicy;
  headed: boolean;
  managedChromium: boolean;
  allocatedDisplay: boolean;
}): readonly string[] {
  if (!input.headed || !input.managedChromium) return [];
  if (
    input.policy === "operator_enabled" ||
    (input.policy === "allocated_linux" && input.allocatedDisplay)
  ) {
    return ["--disable-gpu"];
  }
  return [];
}
