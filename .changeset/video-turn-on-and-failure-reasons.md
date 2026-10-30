---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Turning video on from a chat asks the person once. Where each change waits for a confirmation card, the video tools tell the agent to run the turn-on action instead of asking first, and the card reads "Let every chat in this workspace make videos? A 5-second 480p clip costs … in Opengeni credits." with "Paid with: Opengeni credits" underneath, instead of "Update video generation policy in this workspace?" and the raw funding code. Full-access chats still ask in the chat first, since nothing else would.

A video whose start the provider refuses now says which side refused and that nothing was charged: the service's own video account ("Video isn't working on this service right now … Trying again won't help until the service is fixed."), the workspace's own gateway or SuperGrok account (a workspace admin can fix it in Settings), or the description itself ("Rewording it may help."). Other failures of credit-paid videos add "Nothing was charged.", since their credits are always refunded.
