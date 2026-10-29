---
"@opengeni/contracts": patch
"@opengeni/capabilities": patch
"@opengeni/react": patch
"@opengeni/react-native": patch
---

Approval cards for long HTML emails now list every link target the reader doesn't show in full, however long the message is: a "Links:" line leads the preview, and anything past its limit points to Details. Link addresses decode exactly as a browser does (every named reference, numeric references without a semicolon), a form's submit destination counts as a link, and paragraph and line breaks read as breaks. Operation titles: Stripe-style ids such as `PostChargesChargeCapture` read "Capture charge", and `users.user.sendMail` reads "Send an email".

The integration Connect card keeps every line true: when the sign-in window is gone while waiting it asks "Closed the sign-in window? Open it again to finish." with one clear button, the "You can close the sign-in window." reminder goes once the window closes, and keyboard focus stays on the card after connecting. The code step reads in order (code, a button-styled "Open the sign-in page", then what to do there) on web and phone, and "Waiting for authorization" now reads "Waiting for you to sign in".
