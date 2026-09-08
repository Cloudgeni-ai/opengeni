import { useCallback, useEffect, useState } from "react";
import type { PersonalAttachmentMode } from "./personal-resource-attachments";

/** A local choice for the next explicit human submission, never a grant mutation. */
export function usePersonalResourceScopeChoice(
  identityKey: string,
  visibility: "private" | "workspace",
) {
  const key = `${identityKey}:${visibility}`;
  const [choice, setChoice] = useState<{ key: string; mode: PersonalAttachmentMode }>({
    key,
    mode: "once",
  });
  useEffect(() => {
    setChoice((current) => (current.key === key ? current : { key, mode: "once" }));
  }, [key]);
  const consume = useCallback(
    (acceptedMode: PersonalAttachmentMode) => {
      setChoice((current) =>
        current === choice && current.key === key && current.mode === acceptedMode
          ? { key, mode: "once" }
          : current,
      );
    },
    [choice, key],
  );
  return {
    consume,
    mode:
      visibility === "private"
        ? ("session" as const)
        : choice.key === key
          ? choice.mode
          : ("once" as const),
    setMode: (mode: PersonalAttachmentMode) => setChoice({ key, mode }),
  };
}
