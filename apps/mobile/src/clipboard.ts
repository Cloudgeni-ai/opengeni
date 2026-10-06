// Clipboard through expo-clipboard when the running native build includes it.
export async function copyText(text: string): Promise<void> {
  try {
    const Clipboard = require("expo-clipboard") as typeof import("expo-clipboard");
    await Clipboard.setStringAsync(text);
  } catch {
    // Older dev builds without the native module: copying is a no-op.
  }
}
