---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/desktop": minor
---

The desktop app can remind you about a minute before a calendar meeting with a Google Meet, Zoom, Teams or Webex link: a card in the corner says "<title> · Starts in 1 min" with Join and start notes, which opens the meeting and starts its recording, named after the calendar event. While another meeting is being recorded it offers Join and switch notes. Only the active account reminds, each meeting once, and Settings → Computer use → Voice has a switch for it, with a link to connect a calendar when none is.

New `GET /v1/workspaces/:workspaceId/upcoming-meetings` lists the caller's own meetings about to start with their join links (`listUpcomingMeetings` in the SDK). Creating a recording accepts `calendarEvent` (`{ provider, id }`), which names it after that event and is kept in `metadata.calendarEvent`. `createMeetingDetection` takes a `calendar` option and has `accountChanged()`, `refreshCalendar()` and `shutdown()`.
