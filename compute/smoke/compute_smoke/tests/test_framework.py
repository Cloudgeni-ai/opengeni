"""The framework's own contracts: declaring scenarios, verdicts, cleanup,
suite exit codes and sharding."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import time
import unittest

import compute_smoke as smoke
from compute_smoke.model import Verdict
from compute_smoke.registry import scenario
from compute_smoke.runtime import (
    InvariantViolation,
    QuarantinedSmoke,
    ScenarioContext,
    ScenarioTerminated,
    execute_scenario,
)
from compute_smoke.scenarios import REGISTRY
from compute_smoke.sharding import select_shard
from compute_smoke.suite import (
    RESULT_PREFIX,
    ScenarioProcessResult,
    run_scenarios,
    suite_exit_code,
)


def _declare(scenario_id: str, **options: object) -> smoke.Scenario:
    def verify(test: smoke.Ecw) -> None:
        """Does nothing."""

    return scenario(scenario_id, **options)(verify)


class DeclaringScenarios(unittest.TestCase):
    def test_a_scenario_takes_its_category_and_invariant_from_its_declaration(
        self,
    ) -> None:
        declared = _declare("ecw.example_case")
        self.assertEqual(declared.category, "ecw")
        self.assertEqual(declared.invariant, "Does nothing.")
        self.assertEqual(declared.fixture_type, smoke.Ecw)

    def test_malformed_declarations_are_refused(self) -> None:
        for bad_id in ("", "ecw.", ".x", "a..b"):
            with self.subTest(bad_id=bad_id), self.assertRaises(ValueError):
                _declare(bad_id)
        with self.assertRaises(ValueError):
            _declare("ecw.x", quarantined="  ")
        with self.assertRaises(ValueError):
            _declare("ecw.x", quarantined="reason", ignored="reason")
        with self.assertRaises(ValueError):
            _declare("ecw.x", sandboxes=0)

    def test_a_scenario_needs_a_docstring_and_a_known_fixture(self) -> None:
        def undocumented(test: smoke.Ecw) -> None:
            pass

        with self.assertRaises(ValueError):
            scenario("ecw.undocumented")(undocumented)

        def untyped(test: int) -> None:
            """Takes something that is not a fixture."""

        with self.assertRaises(TypeError):
            scenario("ecw.untyped")(untyped)

    def test_every_shipped_scenario_loads(self) -> None:
        ids = [registered.id for registered in REGISTRY]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertGreaterEqual(len(ids), 20)
        self.assertEqual(set(REGISTRY.categories), {"compute", "ecw"})
        for registered in REGISTRY:
            self.assertTrue(registered.invariant, registered.id)


class Verdicts(unittest.TestCase):
    def run_body(self, body, **options) -> smoke.ScenarioResult:
        return execute_scenario(title="Example", body=body, **options)

    def test_a_body_that_returns_passes_with_its_evidence(self) -> None:
        def body(context: ScenarioContext) -> None:
            context.record("answer", 42)

        result = self.run_body(body)
        self.assertEqual(result.verdict, Verdict.PASS)
        self.assertEqual(result.evidence["answer"], 42)
        self.assertEqual(result.exit_code, 0)

    def test_each_kind_of_failure_gets_its_verdict(self) -> None:
        def violated(_context: ScenarioContext) -> None:
            raise InvariantViolation("files differ")

        def quarantined(_context: ScenarioContext) -> None:
            raise QuarantinedSmoke("known issue")

        def broken(_context: ScenarioContext) -> None:
            raise OSError("socket gone")

        self.assertEqual(self.run_body(violated).verdict, Verdict.FAIL)
        self.assertEqual(self.run_body(quarantined).verdict, Verdict.WARN)
        infra = self.run_body(broken)
        self.assertEqual(infra.verdict, Verdict.INFRA_ERROR)
        self.assertIn("socket gone", infra.summary)
        self.assertTrue(infra.diagnostics)

    def test_a_body_that_overruns_its_deadline_is_an_infrastructure_error(self) -> None:
        def slow(_context: ScenarioContext) -> None:
            time.sleep(5)

        started = time.monotonic()
        result = self.run_body(slow, timeout_seconds=0.5)
        self.assertEqual(result.verdict, Verdict.INFRA_ERROR)
        self.assertLess(time.monotonic() - started, 3)

    def test_cleanup_runs_last_first_and_only_critical_failures_change_the_verdict(
        self,
    ) -> None:
        order: list[str] = []

        def fail() -> None:
            raise RuntimeError("could not delete")

        def body(critical: bool):
            def run(context: ScenarioContext) -> None:
                context.scope.defer("first", lambda: order.append("first"))
                context.scope.defer("failing", fail, critical=critical)
                context.scope.defer("last", lambda: order.append("last"))

            return run

        mild = self.run_body(body(critical=False))
        self.assertEqual(order, ["last", "first"])
        self.assertEqual(mild.verdict, Verdict.PASS)
        self.assertEqual(len(mild.cleanup_failures), 1)
        severe = self.run_body(body(critical=True))
        self.assertEqual(severe.verdict, Verdict.INFRA_ERROR)
        self.assertIn("critical cleanup failed", severe.summary)

    def test_a_disarmed_cleanup_does_not_run(self) -> None:
        ran: list[str] = []

        def body(context: ScenarioContext) -> None:
            context.scope.defer("delete", lambda: ran.append("delete")).disarm()

        self.run_body(body)
        self.assertEqual(ran, [])

    def test_cleanup_runs_before_an_interruption_continues(self) -> None:
        def interrupted(error: BaseException):
            def run(context: ScenarioContext) -> None:
                context.scope.defer("delete", lambda: cleaned.append(type(error).__name__))
                raise error

            return run

        for error in (KeyboardInterrupt(), SystemExit(0)):
            cleaned: list[str] = []
            with self.subTest(error=type(error).__name__), self.assertRaises(type(error)):
                self.run_body(interrupted(error))
            self.assertEqual(cleaned, [type(error).__name__])

    def test_sigterm_unwinds_through_cleanup_and_restores_the_handler(self) -> None:
        cleaned: list[str] = []
        before = signal.getsignal(signal.SIGTERM)

        def body(context: ScenarioContext) -> None:
            context.scope.defer("delete", lambda: cleaned.append("delete"))
            os.kill(os.getpid(), signal.SIGTERM)
            time.sleep(5)
            cleaned.append("body went on")

        started = time.monotonic()
        with self.assertRaises(ScenarioTerminated):
            self.run_body(body)
        self.assertLess(time.monotonic() - started, 3)
        self.assertEqual(cleaned, ["delete"])
        self.assertEqual(signal.getsignal(signal.SIGTERM), before)

    def test_sigterm_during_cleanup_lets_cleanup_finish_first(self) -> None:
        cleaned: list[str] = []

        def body(context: ScenarioContext) -> None:
            context.scope.defer("second", lambda: cleaned.append("second"))
            context.scope.defer("first", lambda: os.kill(os.getpid(), signal.SIGTERM))

        with self.assertRaises(ScenarioTerminated):
            self.run_body(body)
        self.assertEqual(cleaned, ["second"])


class SuiteExitCode(unittest.TestCase):
    @staticmethod
    def reported(
        scenario_id: str, returncode: int, verdict: str | None, *, reported_id: str | None = None
    ) -> ScenarioProcessResult:
        report = (
            None
            if verdict is None
            else {"scenario_id": reported_id or scenario_id, "verdict": verdict}
        )
        return ScenarioProcessResult(scenario_id, returncode, "", "", report)

    @classmethod
    def results(cls, *codes: int) -> list[ScenarioProcessResult]:
        """Results whose reports agree with their codes."""

        verdicts = {0: "pass", 42: "warn", 1: "fail", 2: "infra_error"}
        return [cls.reported(f"ecw.s{i}", code, verdicts.get(code)) for i, code in enumerate(codes)]

    def test_the_worst_outcome_decides(self) -> None:
        self.assertEqual(suite_exit_code(self.results()), 0)
        self.assertEqual(suite_exit_code(self.results(0, 0)), 0)
        self.assertEqual(suite_exit_code(self.results(0, 42)), 42)
        self.assertEqual(suite_exit_code(self.results(42, 2)), 2)
        self.assertEqual(suite_exit_code(self.results(2, 1)), 1)
        # A crash with an unknown status counts as an infrastructure error.
        self.assertEqual(suite_exit_code(self.results(0, -9)), 2)

    def test_an_exit_status_counts_only_with_a_matching_verdict(self) -> None:
        self.assertEqual(self.reported("ecw.a", 0, "pass").exit_code, 0)
        self.assertEqual(self.reported("ecw.a", 1, "fail").exit_code, 1)
        self.assertEqual(self.reported("ecw.a", 42, "warn").exit_code, 42)
        self.assertEqual(self.reported("ecw.a", 2, "inconclusive").exit_code, 2)
        untrusted = {
            "no report, as after sys.exit(0)": self.reported("ecw.a", 0, None),
            "a report for another scenario": self.reported("ecw.a", 0, "pass", reported_id="ecw.b"),
            "a status that contradicts the verdict": self.reported("ecw.a", 0, "fail"),
            "an unknown verdict": self.reported("ecw.a", 0, "great"),
            "a terminated scenario": self.reported("ecw.a", 143, None),
        }
        for case, result in untrusted.items():
            with self.subTest(case=case):
                self.assertEqual(result.exit_code, 2)

    def test_a_process_that_exits_zero_without_a_verdict_does_not_pass(self) -> None:
        def runner(command: list[str], **_: object) -> subprocess.CompletedProcess[str]:
            scenario_id = command[-1]
            stdout = "--- set up\n"
            if scenario_id == "ecw.reports":
                report = {"scenario_id": scenario_id, "verdict": "pass"}
                stdout += RESULT_PREFIX + json.dumps(report) + "\n"
            return subprocess.CompletedProcess(command, 0, stdout, "")

        reports, exits_early = (
            _declare("ecw.reports"),
            _declare("ecw.exits_early"),
        )
        results = run_scenarios([reports, exits_early], environment={}, process_runner=runner)
        self.assertEqual([result.exit_code for result in results], [0, 2])
        self.assertEqual(suite_exit_code(results), 2)


class Sharding(unittest.TestCase):
    def test_shards_cover_every_scenario_once_whatever_the_input_order(self) -> None:
        scenarios = tuple(REGISTRY)
        for count in (1, 2, 3, 5):
            # Shard indexes are 1-based, as on the command line.
            shards = [
                select_shard(scenarios, index=index, count=count, api_surface="ecw")
                for index in range(1, count + 1)
            ]
            reversed_shards = [
                select_shard(
                    tuple(reversed(scenarios)),
                    index=index,
                    count=count,
                    api_surface="ecw",
                )
                for index in range(1, count + 1)
            ]
            self.assertEqual(shards, reversed_shards, f"{count} shards")
            placed = [registered.id for shard in shards for registered in shard]
            self.assertCountEqual(placed, [registered.id for registered in scenarios])


if __name__ == "__main__":
    unittest.main()
