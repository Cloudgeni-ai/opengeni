// The web app's router backs the shared session UI's navigation. Each call
// reads the router module at call time, so a test's module mock applies too.
import * as Router from "@tanstack/react-router";

import {
  browserPage,
  type NavigateFunction,
  type NavigationHost,
  type NavigationLocation,
  type NavigationState,
} from "@opengeni/react/app/lib/navigation";
import { configurePageAppHost } from "@opengeni/react/app/lib/app-host";

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** Set only on the Settings "Back to sessions" link that reopens this session. */
    restoredSessionId?: string;
  }
}

// TanStack's hooks are generic over the registered route tree; the shared UI
// makes the same calls with untyped paths.
const webNavigationHost: NavigationHost = {
  useNavigate: () => Router.useNavigate() as NavigateFunction,
  useLocation: () => Router.useLocation() as NavigationLocation,
  useRouterState: <T,>(options: { select: (state: NavigationState) => T }) =>
    Router.useRouterState(options as never) as T,
  useRouter: () => Router.useRouter() as unknown as { readonly state: NavigationState },
  useSearch: (options) => Router.useSearch(options),
  Link: (props) => <Router.Link {...(props as Router.LinkProps)} />,
  stringifySearch: (search) => Router.defaultStringifySearch(search),
  page: browserPage,
};

configurePageAppHost({ navigation: webNavigationHost });
