"""Regression E2E fixture: dataset-backed experiment that then raises
`RegressionError` to exercise the non-fatal failure path.

"""

from typing import Any, NoReturn

from langfuse import Evaluation, RegressionError, RunnerContext


def _task(*, item: Any, **kwargs: Any) -> str:
    value = item["input"] if isinstance(item, dict) else item.input
    return value.upper()


def _exact_match(*, output: str, expected_output: str, **kwargs: Any) -> Evaluation:
    return Evaluation(
        name="exact_match",
        value=1.0 if output == expected_output else 0.0,
    )


def experiment(context: RunnerContext) -> NoReturn:
    result = context.run_experiment(
        name="Regression fixture",
        task=_task,
        evaluators=[_exact_match],
    )
    # Always raise — simulates a gate check that rejected the run.
    raise RegressionError(
        result=result, message="synthetic regression triggered by e2e fixture"
    )
