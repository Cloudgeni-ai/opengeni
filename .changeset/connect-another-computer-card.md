---
"@opengeni/react": patch
"@opengeni/react-native": patch
---

Connecting a computer that isn't connected yet is now an obvious action in the in-chat Connected Machine card. The card ends with an **Another computer** row whose **Connect** opens the connect flow, instead of a small link under everything else, and no listed machine gets the primary button just because it is the only one online. Screen control and the Chrome extension rows show only for the machine this chat runs on, so steps about a machine the person may not mean no longer compete with choosing or connecting the right one. Without a host connect callback, the embedded card's **Connect another computer** opens in place as a disclosure that says the steps happen on the other computer.

On the web, the shared `ThisComputerCard` keeps **Connect another computer** as a secondary action beside a connected computer when the host supplied a connect path (`onConnect`, `downloads`, `openAppUrl` or `downloadUrl`). On the phone, `useNativeInChatConnect` accepts an optional `shareConversation` callback; with it, the computer offer explains that a computer connects from the computer itself and offers **Share link to this chat**.
