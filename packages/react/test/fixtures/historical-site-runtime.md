# Historical saved Site runtime

`site-browser-runtime.e080c190.txt` is the exact generated file retained as test data from
`packages/sdk/src/site-browser-runtime.gen.ts` at commit
`e080c19084e87f07d481e92fd7b4ae8b671d01af`, not a rebuild with today's SDK.
SHA-256 of the complete retained file:
`0db71e767389ee86cefb77823d17976d4f14f2322900e7cd72d3ada2fba057f3`.

The compatibility tests verify the hash before loading this retained module as
data (it is not current product source), evaluate its built IIFE, and connect its real client to
the current host over MessagePort. Its historical code-only stale classifier
is deliberately retained: replacing the fixture with a current catalog-mode
client would hide duplicate execution in already-saved Sites.

Tests require neither Git nor network access. To retain the same original bytes
again, run `bun packages/react/test/fixtures/retain-historical-site-runtime.ts`
from a checkout containing that commit. Do not run the current runtime generator
on this fixture. It contains repository-generated code, not captured user data.
