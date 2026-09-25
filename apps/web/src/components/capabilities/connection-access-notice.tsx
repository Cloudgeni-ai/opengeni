import { Notice } from "@/components/ui/notice";

/** Shown when connection discovery is unavailable to the current workspace grant. */
export function ConnectionAccessNotice() {
  return (
    <Notice title="Connection access required" tone="info" className="mt-4">
      Your workspace access doesn’t allow connection discovery. Ask a workspace admin for connection
      access to use connected tools here and in chat.
    </Notice>
  );
}
