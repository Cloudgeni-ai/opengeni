import { toast } from "./toast";
import { userErrorText } from "../../ui/api-error";

/** Puts text on the clipboard, with a fallback for embeds without the async clipboard. */
export async function writeClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Older embeds without the async clipboard: a hidden textarea and execCommand.
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("The browser blocked copying.");
}

/**
 * Copies an address and says so, the same way for chats and artifacts:
 * "Link copied", or why it couldn't be copied.
 */
export async function copyLink(url: string): Promise<void> {
  try {
    await writeClipboard(url);
    toast.success("Link copied");
  } catch (error) {
    toast.error("Couldn't copy the link.", { description: userErrorText(error) });
  }
}
