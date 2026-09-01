export function isExpectedFirefoxWebGLUnavailableWarning(diagnostic: string): boolean {
  const match =
    /^console\.warning: \[JavaScript Warning: "Failed to create WebGL context: WebGL creation failed:\n\* AllowWebgl2:false restricts context creation on this system\. \(\)" \{file: "([^"\r\n]+)" line: ([1-9]\d*)\}\]$/u.exec(
      diagnostic,
    );
  if (!match) return false;
  try {
    const source = new URL(match[1]!);
    return (
      source.protocol === "http:" &&
      (source.hostname === "127.0.0.1" || source.hostname === "localhost") &&
      source.pathname.endsWith("/node_modules/.vite/deps/@xterm_addon-webgl.js") &&
      source.searchParams.size === 1 &&
      /^[0-9a-f]+$/iu.test(source.searchParams.get("v") ?? "")
    );
  } catch {
    return false;
  }
}
