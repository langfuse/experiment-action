"""E2E fixture: deterministic dataset-backed experiment against Langfuse."""

from typing import Any

from langfuse import Evaluation, RunnerContext


def uppercase_task(*, item: Any, **kwargs: Any) -> str:
    value = item["input"] if isinstance(item, dict) else item.input
    return value.upper()


def exact_match(*, output: str, expected_output: str, **kwargs: Any) -> Evaluation:
    return Evaluation(
        name="exact_match",
        value=1.0 if output == expected_output else 0.0,
        comment="match"
        if output == expected_output
        else f"expected {expected_output!r}, got {output!r}",
    )


def avg_accuracy(*, item_results: list[Any], **kwargs: Any) -> Evaluation:
    scores = [
        evaluation.value
        for item in item_results
        for evaluation in item.evaluations
        if evaluation.name == "exact_match"
    ]
    avg = sum(scores) / len(scores) if scores else 0.0
    return Evaluation(
        name="avg_accuracy",
        value=avg,
        comment=f"{len(scores)} items, avg={avg:.3f}",
    )


def experiment(context: RunnerContext) -> Any:
    return context.run_experiment(
        name="Uppercase (py)",
        description="Deterministic string-transform task; no LLM involved.",
        task=uppercase_task,
        evaluators=[exact_match],
        run_evaluators=[avg_accuracy],
    )
