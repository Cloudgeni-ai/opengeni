---
"@opengeni/react": patch
---

The app shell supports a simplified interface for people who arrive from gogeni.ai. It is a per-browser presentation flag (`?simplified_interface=1` on the landing URL, `=0` to turn it off) that the web app stores locally and never sends to the server. While it is on, the product reads "Geni", the rail and settings list fewer destinations (Knowledge and Automations move under "Advanced"), the composer offers only files and voice, new chats and schedules use one credit-billed model, and suggestions and automation templates speak to business work. Off is the default and nothing changes for other browsers; every page still opens by its address, and no permission depends on the flag. `useSimplifiedInterface()` from `@opengeni/react/app/lib/simplified-interface` reads it, and components rendered without its provider behave as before.
