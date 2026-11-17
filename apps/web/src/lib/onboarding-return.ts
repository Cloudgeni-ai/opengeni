/** The part of the app router that onboarding needs to leave a path with no page. */
export type OnboardingReturnRouter = {
  getMatchedRoutes(pathname: string): readonly [unknown, unknown, unknown];
  state: { location: { pathname: string } };
  navigate(options: { to: "/"; replace: true }): Promise<unknown>;
};

/** Whether the app has a page for `pathname`, so a reload or revalidation there shows it. */
export function pathHasAppPage(router: OnboardingReturnRouter, pathname: string): boolean {
  return router.getMatchedRoutes(pathname)[2] !== undefined;
}

/**
 * Signed-out visitors see sign-in and onboarding on whatever path they opened
 * (for example a `/sign-in` link from a website). Onboarding that finishes
 * without its own destination stays where it is, which is right for a deep
 * link but shows Page not found on a path the app has no page for. Go home
 * in that case; it opens the person's workspace.
 */
export async function leaveOnboardingPathWithoutPage(
  router: OnboardingReturnRouter,
): Promise<void> {
  if (pathHasAppPage(router, router.state.location.pathname)) return;
  await router.navigate({ to: "/", replace: true });
}
