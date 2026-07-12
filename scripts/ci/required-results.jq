.plan.result == "success" and
.typecheck.result == "success" and
.guards.result == "success" and
(if $unit == 0 then .unit.result == "skipped" else .unit.result == "success" end) and
(if $integration == 0 then .integration.result == "skipped" else .integration.result == "success" end) and
(if $e2e == 0 then .e2e.result == "skipped" else .e2e.result == "success" end) and
(if $build == 0 then .packages.result == "skipped" else .packages.result == "success" end) and
(if $mode == "docs" then
   .deployment.result == "skipped" and .images.result == "skipped"
 else
   .deployment.result == "success" and .images.result == "success"
 end)