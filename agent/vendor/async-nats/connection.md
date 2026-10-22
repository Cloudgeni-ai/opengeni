 User needs a way to customize how connections and reconnections are done.
 Currently, there are only two modes:

 a) client randomizes provided set of servers (and discovered servers)
 b) client retains the order

 # What we want

 Ability for the client to alter servers that are picked for reconnection.

# Proposed solution

User has access to two callbacks:
## Server info callback
When server sends to the client new INFO, which can happen when server discoveres new servers in the cluster
## Reconnect callback
When client is about to reconnect
It's different from the current reconnect callback, which is purely informative

## What to do
When the callback is triggered, it provides user with most available information
1. list of all servers (passed by user and discovered)
2. all additional available info - probably most recent server INFO

Then, the user provides back to the client a  single server
Then, the client updates its internal list of servers to use for reconnection with that server
Then, the client internally uses that provided server for next reconneciton.

## How to test
Very simple test can be performed to confirm that its working properly
1. Test creates a server like any other test
2. User passes arbitrary server - not existing one
3. next reconnect is triggered as the first one fails. User passes the proper one
4. test validates that the connection is established

## Challenges for rust client
Currently, client shuffles (or not) then iterates thorugh the list.
This change requires that for each single reconnect attempt, we check the callback if it is `Some`

## Implementation details
Consider sync vs async callback - check how event callback are done.
