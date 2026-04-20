"""Mixed-runtime e2e fixture (Python side): runs a real experiment."""

from langfuse import Evaluation, get_client


def _task(*, item, **kwargs):
    return item["input"].upper()


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
    return langfuse.run_experiment(
        name="experiment-action e2e: mixed dir (python)",
        data=[
            {"input": "python", "expected_output": "PYTHON"},
            {"input": "langfuse", "expected_output": "LANGFUSE"},
        ],
        task=_task,
        evaluators=[_exact_match],
        run_evaluators=[_avg_accuracy],
    )
