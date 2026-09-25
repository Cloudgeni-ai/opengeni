---
"@opengeni/contracts": minor
---

Add first-touch sign-up attribution contracts: the closed-charset `SignupAttribution` schema (slug tokens of `A-Z a-z 0-9 . _ ~ + -`, at most 100 characters) with its URL parameter names, the `SIGNUP_ACQUISITION_SOURCES` channel set, and `signupAcquisitionSource`, which normalizes untrusted campaign parameters into `producthunt`, `website`, `direct`, or `other` for bounded sign-up metrics. `StartManagedAuthSocialTransactionRequest` accepts an optional `attribution`; an invalid value is dropped rather than failing the social start.
