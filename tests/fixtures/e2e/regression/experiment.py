"""Regression e2e fixture: runs a real experiment and then raises
`RegressionError` to exercise the non-fatal failure path.

The action detects this by error class name (`type(exc).__name__ ==
"RegressionError"`), so a locally-defined class works — no SDK import
needed for the error type. Once `langfuse` exposes `RegressionError`
natively this can switch to `from langfuse import RegressionError`.
"""

from langfuse import Evaluation, get_client


class RegressionError(Exception):
    def __init__(self, result=None):
        super().__init__("synthetic regression triggered by e2e fixture")
        self.result = result


def _task(*, item, **kwargs):
    return item["input"].upper()


def _exact_match(*, output, expected_output, **kwargs):
    return Evaluation(
        name="exact_match",
        value=1.0 if output == expected_output else 0.0,
    )


def experiment():
    langfuse = get_client()
    result = langfuse.run_experiment(
        name="Regression fixture",
        data=[{"input": "regression", "expected_output": "REGRESSION"}],
        task=_task,
        evaluators=[_exact_match],
    )
    # Always raise — simulates a gate check that rejected the run.
    raise RegressionError(result=result)
