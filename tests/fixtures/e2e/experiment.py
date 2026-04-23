"""E2E fixture: deterministic dataset-backed experiment against Langfuse."""

import os

from langfuse import Evaluation, get_client

def uppercase_task(*, item, **kwargs):
    value = item["input"] if isinstance(item, dict) else item.input
    return value.upper()


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
    dataset = langfuse.get_dataset(os.environ["LANGFUSE_DATASET_NAME"])
    return dataset.run_experiment(
        name="Uppercase (py)",
        description="Deterministic string-transform task; no LLM involved.",
        task=uppercase_task,
        evaluators=[exact_match],
        run_evaluators=[avg_accuracy],
    )
