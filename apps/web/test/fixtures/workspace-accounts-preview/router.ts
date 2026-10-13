// The Models page navigates by search params; the harness keeps them in state.
type Search = { account?: string; view?: string; workspace?: string };
let navigateTo: (search: Search) => void = () => {};

export function setNavigate(next: (search: Search) => void) {
  navigateTo = next;
}

export function useNavigate() {
  return (options: { search?: Search | ((previous: Search) => Search) }) => {
    const search = typeof options.search === "function" ? options.search({}) : options.search;
    navigateTo(search ?? {});
  };
}

export function Link({ children }: { children?: unknown }) {
  return children as never;
}
