"""Mixed-runtime E2E fixture (Python side): dataset-backed experiment."""

import os

from langfuse import Evaluation, get_client


def _task(*, item, **kwargs):
    value = item["input"] if isinstance(item, dict) else item.input
    return value.upper()


def _exact_match(*, output, expected_output, **kwargs):
    return Evaluation(
        name="exact_match",
        value=1.0 if output == expected_output else 0.0,
    )


def _avg_accuracy(*, item_results, **kwargs):
    scores = [
        evaluation.value
        for item in item_results
        for evaluation in item.evaluations
        if evaluation.name == "exact_match"
    ]
    avg = sum(scores) / len(scores) if scores else 0.0
    return Evaluation(name="avg_accuracy", value=avg)


def experiment():
    langfuse = get_client()
    dataset = langfuse.get_dataset(os.environ["LANGFUSE_DATASET_NAME"])
    return dataset.run_experiment(
        name="Mixed dir (python)",
        task=_task,
        evaluators=[_exact_match],
        run_evaluators=[_avg_accuracy],
    )
