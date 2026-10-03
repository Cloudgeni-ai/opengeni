/* URL state for Settings > Access:
     ?section=access                                 the list
     ?section=access&view=add                        Add people (a form page)
     ?section=access&view=custom&member=<subject>    Custom permissions for one person */

export type AccessUrlView = "add" | "custom";

export interface AccessSearch {
  view?: AccessUrlView;
  member?: string;
}

const SUBJECT = /^[\w:@.+-]{1,256}$/;

export function parseAccessSearch(search: Record<string, unknown>): AccessSearch {
  if (search.view === "add") return { view: "add" };
  if (
    search.view === "custom" &&
    typeof search.member === "string" &&
    SUBJECT.test(search.member)
  ) {
    return { view: "custom", member: search.member };
  }
  return {};
}

/** The page open in place of the list, in the shape the Access page takes. */
export function accessViewOf(
  search: AccessSearch,
): { kind: "add" } | { kind: "custom"; subjectId: string } | null {
  if (search.view === "add") return { kind: "add" };
  if (search.view === "custom" && search.member)
    return { kind: "custom", subjectId: search.member };
  return null;
}

export function accessSearchOf(
  view: { kind: "add" } | { kind: "custom"; subjectId: string } | null,
): AccessSearch {
  if (!view) return {};
  return view.kind === "add" ? { view: "add" } : { view: "custom", member: view.subjectId };
}
