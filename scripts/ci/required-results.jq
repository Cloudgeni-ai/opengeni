.plan.result == "success" and
."source-contracts".result == "success" and
(if $unit == 0 then ."unit-shards".result == "skipped" else ."unit-shards".result == "success" end) and
(if $integration == 0 then ."integration-shards".result == "skipped" else ."integration-shards".result == "success" end) and
(if $e2e == 0 then ."e2e-shards".result == "skipped" else ."e2e-shards".result == "success" end) and
(if $artifactRuntime then ."artifact-runtime".result == "success" else ."artifact-runtime".result == "skipped" end) and
(if $build == 0 then ."package-contracts".result == "skipped" else ."package-contracts".result == "success" end) and
(if $mode == "docs" then
   ."test-suite".result == "skipped" and
   ."browser-acceptance".result == "skipped" and
   .deployment.result == "skipped" and
   .images.result == "skipped"
 else
   ."test-suite".result == "success" and
   (if $browser == 0 then ."browser-acceptance".result == "skipped" else ."browser-acceptance".result == "success" end) and
   .deployment.result == "success" and
   (if $mode == "full" then .images.result == "success" else .images.result == "skipped" end)
 end)
