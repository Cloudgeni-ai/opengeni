.plan.result == "success" and
."source-contracts".result == "success" and
(if $event == "pull_request" then
   (if $unit == 0 then ."unit-shards".result == "skipped" else ."unit-shards".result == "success" end) and
   ."unit-safety".result == "skipped"
 else
   ."unit-shards".result == "skipped" and
   (if $unit == 0 then ."unit-safety".result == "skipped" else ."unit-safety".result == "success" end)
 end) and
(if $integration == 0 then ."integration-shards".result == "skipped" else ."integration-shards".result == "success" end) and
(if $build == 0 then ."package-contracts".result == "skipped" else ."package-contracts".result == "success" end) and
(if $mode == "docs" then
   ."test-suite".result == "skipped" and
   ."browser-acceptance".result == "skipped" and
   .deployment.result == "skipped" and
   .images.result == "skipped"
 else
   ."test-suite".result == "success" and
   ."browser-acceptance".result == "success" and
   .deployment.result == "success" and .images.result == "success"
 end)