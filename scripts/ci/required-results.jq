# $preImage: the release-image-validation gate runs before any image job, so
# it must not see image results and checks every other lane exactly as the
# final aggregate does.
#
# $attested (optional, default false): a main push whose exact tree already
# passed a trusted Batch CI attempt (docs/merge-batcher.md "Main-push Batch CI
# attestation"). Every test lane must be skipped, never partially run, and
# only full-mode pushes that build workload images qualify; deployment,
# artifact runtime and images keep their ordinary requirements.
($ARGS.named.attested // false) as $attested |
if $attested then
.plan.result == "success" and
$event == "push" and $mode == "full" and $bakeImages and
."source-contracts".result == "skipped" and
."unit-shards".result == "skipped" and
."integration-shards".result == "skipped" and
."e2e-shards".result == "skipped" and
."test-suite".result == "skipped" and
."browser-acceptance".result == "skipped" and
."browserd-real-e2e".result == "skipped" and
."package-contracts".result == "skipped" and
(if $artifactRuntime then ."artifact-runtime".result == "success" else ."artifact-runtime".result == "skipped" end) and
.deployment.result == "success" and
(if $preImage then (has("images") | not) else .images.result == "success" end)
else
.plan.result == "success" and
."source-contracts".result == "success" and
(if $unit == 0 then ."unit-shards".result == "skipped" else ."unit-shards".result == "success" end) and
(if $integration == 0 then ."integration-shards".result == "skipped" else ."integration-shards".result == "success" end) and
(if $e2e == 0 then ."e2e-shards".result == "skipped" else ."e2e-shards".result == "success" end) and
(if $artifactRuntime then ."artifact-runtime".result == "success" else ."artifact-runtime".result == "skipped" end) and
(if $build == 0 then ."package-contracts".result == "skipped" else ."package-contracts".result == "success" end) and
(if $mode == "docs" and ($bakeImages | not) then
   ."test-suite".result == "skipped" and
   ."browser-acceptance".result == "skipped" and
   ."browserd-real-e2e".result == "skipped" and
   .deployment.result == "skipped" and
   (if $preImage then (has("images") | not) else .images.result == "skipped" end)
 else
   (if $mode == "docs" then ."test-suite".result == "skipped" else ."test-suite".result == "success" end) and
   (if $browserdRealE2e then ."browserd-real-e2e".result == "success" else ."browserd-real-e2e".result == "skipped" end) and
   (if $browser == 0 then ."browser-acceptance".result == "skipped" else ."browser-acceptance".result == "success" end) and
   .deployment.result == "success" and
   (if $preImage then (has("images") | not)
    elif $bakeImages then .images.result == "success"
    else .images.result == "skipped" end)
 end)
end
