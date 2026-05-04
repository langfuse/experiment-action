"""Mixed-runtime E2E fixture (Python side): dataset-backed experiment."""

from typing import Any

from langfuse import Evaluation, RunnerContext


def _task(*, item: Any, **kwargs: Any) -> str:
    value = item["input"] if isinstance(item, dict) else item.input
    return value.upper()


def _exact_match(*, output: str, expected_output: str, **kwargs: Any) -> Evaluation:
    return Evaluation(
        name="exact_match",
        value=1.0 if output == expected_output else 0.0,
    )


def _avg_accuracy(*, item_results: list[Any], **kwargs: Any) -> Evaluation:
    scores = [
        evaluation.value
        for item in item_results
        for evaluation in item.evaluations
        if evaluation.name == "exact_match"
    ]
    avg = sum(scores) / len(scores) if scores else 0.0
    return Evaluation(name="avg_accuracy", value=avg)


def experiment(context: RunnerContext) -> Any:
    return context.run_experiment(
        name="Mixed dir (python)",
        task=_task,
        evaluators=[_exact_match],
        run_evaluators=[_avg_accuracy],
    )
