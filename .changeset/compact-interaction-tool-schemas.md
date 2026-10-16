---
"@opengeni/runtime": patch
---

Browser and computer tool definitions are about four times smaller for the model. Each tagged union, such as a browser action and its locator, is now shown once as a single object with one line listing the fields each variant takes, instead of repeating the locator in every action. Limits that only matter for validation are left out of what the model sees; the tools still enforce them. When arguments are invalid, the error now names the exact field, such as `action.locator.role: expected string`, instead of only saying the arguments are invalid.
