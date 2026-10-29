---
"@opengeni/contracts": patch
"@opengeni/capabilities": patch
"@opengeni/react": patch
"@opengeni/react-native": patch
---

Approval cards for long HTML emails now list every link target the reader doesn't show in full, however long the message is: a "Links:" line leads the preview, and past its limit it says "Details lists every link": the message's Details now lead with every link target, one per row. Link addresses decode exactly as a browser does (every named reference, numeric references without a semicolon), a form's submit destination counts as a link, and paragraph and line breaks read as breaks. Operation titles: Stripe-style ids such as `PostChargesChargeCapture` read "Capture charge", and `users.user.sendMail` reads "Send an email".

The integration Connect card keeps every line true: when it can no longer see the sign-in window while waiting (closed, or cut off by the provider's page, as Google's sign-in pages do) it keeps waiting and says "Finish signing in to {name}. If you closed the sign-in window, open it again." with an Open sign-in window button, the "You can close the sign-in window." reminder goes once the window closes, and keyboard focus stays on the card after connecting. The code step reads in order (code, a button-styled "Open the sign-in page", then what to do there) on web and phone, and "Waiting for authorization" now reads "Waiting for you to sign in".
