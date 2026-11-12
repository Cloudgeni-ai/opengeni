import type { AnyRouter, RouterState } from "@tanstack/react-router";

/**
 * The pathname of the route tree that is actually rendered. During a
 * navigation the router updates `location` first and commits the new matches
 * later, so a shell chosen from `location` would wrap the previous page in the
 * next page's providers. Choose the shell from the rendered leaf match instead.
 */
export function renderedRoutePathname(state: RouterState<AnyRouter["routeTree"]>): string {
  return state.matches.at(-1)?.pathname ?? state.location.pathname;
}
