---
"@opengeni/api-router": patch
---

The personal GitHub gateway treats more GraphQL requests that GitHub might read differently from it as unrecognised, so they ask instead of being misread: a comment ended by a bare carriage return, two operations with the same name, `variables` that isn't a JSON object, a number under an ID input, and names or numbers too long to read in one token.
