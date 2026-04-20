"""E2E fixture: deterministic experiment against a live Langfuse instance.

Defines the dataset inline (no `RunnerContext` yet — coming in v2), uses a
pure string-transform task (no LLM → fully reproducible), and ships both a
per-item evaluator and a run-level evaluator.
"""

from langfuse import Evaluation, get_client


LOCAL_DATA = [
    {"input": "hello", "expected_output": "HELLO"},
    {"input": "world", "expected_output": "WORLD"},
    {"input": "langfuse", "expected_output": "LANGFUSE"},
]


def uppercase_task(*, item, **kwargs):
    return item["input"].upper()


def exact_match(*, output, expected_output, **kwargs):
    return Evaluation(
        name="exact_match",
        value=1.0 if output == expected_output else 0.0,
        comment="match" if output == expected_output else f"expected {expected_output!r}, got {output!r}",
    )


def avg_accuracy(*, item_results, **kwargs):
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


def experiment():
    langfuse = get_client()
    return langfuse.run_experiment(
        name="experiment-action e2e: uppercase task",
        description="Deterministic string-transform task; no LLM involved.",
        data=LOCAL_DATA,
        task=uppercase_task,
        evaluators=[exact_match],
        run_evaluators=[avg_accuracy],
    )
