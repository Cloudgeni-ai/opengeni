---
"@opengeni/react": patch
"@opengeni/react-native": patch
---

Every first-party tool step in the timeline now draws an icon that matches its words (a globe for the browser, a monitor for the screen, a spreadsheet for Excel, an hourglass for waiting, and so on) instead of the generic wrench. The mapping lives in one shared table keyed by tool step, so the web app, React Native and embedded chats all get the same icons; a new step without an icon fails to compile. Connector and custom tools keep their family icon or the wrench.
