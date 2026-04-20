<!-- langfuse-experiment-action run_id=12345 -->

# <img src="https://langfuse.com/brand-assets/icon/color/langfuse-icon.png" height="32" alt="" align="center" /> Langfuse Experiment Results: `abc1234` (#2)

<!-- langfuse-experiment-action:start script=%2Ftmp%2Fexperiment.py -->

## ✅ Uppercase task (`tmp/experiment.py`)

| Score | Value |
| --- | --- |
| `avg_accuracy` | 1.000 |

<details><summary>2 items</summary>

| Item | Input | Output | exact_match |
| --- | --- | --- | --- |
| 1 | hello | HELLO | 1.000 |
| dataset-item-42 | world | WORLD | 1.000 |

</details>

<!-- langfuse-experiment-action:end script=%2Ftmp%2Fexperiment.py -->

<!-- langfuse-experiment-action:start script=%2Ftmp%2Fmixed%2Fexp_node.ts -->

## ✅ experiment-action e2e: mixed dir (node) (`mixed/exp_node.ts`)

| Score | Value |
| --- | --- |
| `avg_accuracy` | 0.830 |

<details><summary>1 item</summary>

| Item | Input | Output | exact_match |
| --- | --- | --- | --- |
| 1 | node | NODE | 1.000 |

</details>

<!-- langfuse-experiment-action:end script=%2Ftmp%2Fmixed%2Fexp_node.ts -->
