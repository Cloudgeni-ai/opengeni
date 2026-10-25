---
"@opengeni/react": minor
"@opengeni/react-native": minor
---

The phone app shows and manages a session's full access like the web header does. `SessionHeaderTitle` takes `fullAccess` and then shows a small shield and "Full access" on its status line. The new `@opengeni/react/session-admin-access-model` entry point shares the offered time limits (`ADMIN_ACCESS_DURATIONS`, `adminAccessDurationHours`), `endsText`, `adminAccessGrantedByText` and the grant description between web and native.
