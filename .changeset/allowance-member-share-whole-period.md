---
"@opengeni/db": patch
"@opengeni/react": patch
---

A member's share of a workspace usage allowance (`equal_share` or `{ share }`) is now a share of the period's whole pool, the same amount as the workspace limit: included credits plus grant credits spent this period plus those left. Before, it was a share of included credits plus the grant credits still left. So every credit anyone spent from a grant lowered every member's limit (for example 19,998 became 19,997), and in a workspace funded only by grants, an equal share of two ran out at about a third of the credits. Usage reads, admission, threshold and exhaustion notifications and `UsageMemberList`'s percentages now agree. A member's share stays steady through the period, rises when credits are bought and starts again from what is left in a new period.
