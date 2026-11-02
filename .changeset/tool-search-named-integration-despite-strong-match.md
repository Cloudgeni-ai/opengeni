---
"@opengeni/runtime": patch
"@opengeni/capabilities": minor
"@opengeni/core": patch
---

`tool_search` now offers the Connect card for an integration the query names even when an unrelated installed tool matches strongly, such as a Slack bot tool for "posts on Slack" or meeting search for "Linear issues". The integration catalog lookup is skipped only when a strong match is that integration's own tool; ownership by a shared vendor domain also needs agreeing names, so a Microsoft Teams tool does not hide Microsoft Excel. Beside strong matches the catalog is read only when the query has a capitalised word mid-sentence or a word no installed tool uses, the search waits for it at most 1.5 seconds, and only a distinctive mention names an integration, so "close the ticket" or "linear regression" add no card.

Integration names are also recognised with different spacing or case ("hub spot", "wisprflow"), as near spellings ("whisperflow" for Wispr Flow, "hubsopt" for HubSpot), and by the vendor's word in its registrable domain ("jira" for Atlassian at jira.com) when that domain is one product's ("microsoft" names none of Teams, Excel and OneDrive). Common words close to a name ("email" for Gmail, "conference" for Confluence), plurals ("snowflakes") and compound phrases ("linked in", "the last pass") do not name one. `@opengeni/capabilities` exports the shared matching (`integrationMentionsIn`, `integrationMentionMatcher`, `isDistinctiveIntegrationMention`, `isIntegrationNearSpelling`, `integrationVendorWord`, `integrationQueryWords`, `integrationNamesAgree`, `sharedVendorDomains`, `registrableHostDomain`), and capability catalog search ranks entries a query names distinctively above entries that only share its ordinary words ("send a message" does not promote Send).
