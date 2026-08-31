export function isExpectedFirefoxWebGLUnavailableWarning(diagnostic: string): boolean {
  return (
    diagnostic.startsWith(
      'console.warning: [JavaScript Warning: "Failed to create WebGL context: WebGL creation failed:',
    ) &&
    diagnostic.includes("* AllowWebgl2:false restricts context creation on this system.") &&
    diagnostic.includes("@xterm_addon-webgl.js")
  );
}
