---
"@opengeni/db": patch
"@opengeni/api-router": patch
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": patch
---

Infrastructure-only session events, such as the idle sandbox reaper terminating a shared box, no longer move a session's `updatedAt`, so stopped sessions keep their real last-activity time in the sidebar and session lists (migration 0904). Sessions and session list entries now carry `hasUpcomingSchedules`, and the sidebar schedule icon only appears for schedules that can still fire. A session whose schedules are all paused or expired keeps a distinct "No upcoming runs" schedule button in its header.
