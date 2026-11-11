import { useCallback, type Ref, type RefCallback } from "react";

/**
 * One callback ref that sets every given ref. Components that keep their own
 * ref on an element and also forward the caller's use it, so neither
 * replaces the other.
 */
export function mergeRefs<T>(...refs: Array<Ref<T> | undefined>): RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    }
  };
}

/** {@link mergeRefs} kept stable across renders while the refs stay the same. */
export function useMergedRefs<T>(...refs: Array<Ref<T> | undefined>): RefCallback<T> {
  // The refs are the dependencies.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback(mergeRefs(...refs), refs);
}
