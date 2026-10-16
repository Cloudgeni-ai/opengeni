"""The framework's own contracts: declaring scenarios, verdicts, cleanup,
suite exit codes and sharding."""

from __future__ import annotations

import time
import unittest

import compute_smoke as smoke
from compute_smoke.model import Verdict
from compute_smoke.registry import scenario
from compute_smoke.runtime import (
    InvariantViolation,
    QuarantinedSmoke,
    ScenarioContext,
    execute_scenario,
)
from compute_smoke.scenarios import REGISTRY
from compute_smoke.sharding import select_shard
from compute_smoke.suite import ScenarioProcessResult, suite_exit_code


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


class SuiteExitCode(unittest.TestCase):
    @staticmethod
    def results(*codes: int) -> list[ScenarioProcessResult]:
        return [ScenarioProcessResult(f"ecw.s{i}", code, "", "") for i, code in enumerate(codes)]

    def test_the_worst_outcome_decides(self) -> None:
        self.assertEqual(suite_exit_code(self.results()), 0)
        self.assertEqual(suite_exit_code(self.results(0, 0)), 0)
        self.assertEqual(suite_exit_code(self.results(0, 42)), 42)
        self.assertEqual(suite_exit_code(self.results(42, 2)), 2)
        self.assertEqual(suite_exit_code(self.results(2, 1)), 1)
        # A crash with an unknown status counts as an infrastructure error.
        self.assertEqual(suite_exit_code(self.results(0, -9)), 2)


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
