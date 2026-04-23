<!-- langfuse-experiment-action run_id=12345 -->

# <img src="https://langfuse.com/brand-assets/icon/color/langfuse-icon.png" height="32" alt="" align="center" /> Experiment Results: `abc1234`

<!-- langfuse-experiment-action:overview:start -->
| Experiment | Status | Score | Items | Actions |
| --- | --- | --- | --- | --- |
| Regression fixture | ❌ Regression | `avg_accuracy`: 0.500 | 1 | [View GitHub Action Run](https://github.com/o/r/actions/runs/7/job/42) |
<!-- langfuse-experiment-action:overview:end -->

<!-- langfuse-experiment-action:start script=%2Ftmp%2Freg.py -->
<details open><summary>❌ Regression fixture (`tmp/reg.py`)</summary>

> [!WARNING]
> **RegressionError:** accuracy dropped to 0.5

| Score | Value |
| --- | --- |
| `avg_accuracy` | 0.500 |

<details><summary>Item results (1)</summary>

| Item | Input | Expected | Output | exact_match |
| --- | --- | --- | --- | --- |
| 1 | x | X | X | 1.000 |

</details>

[View GitHub Action Run](https://github.com/o/r/actions/runs/7/job/42)

</details>
<br>
<!-- langfuse-experiment-action:end script=%2Ftmp%2Freg.py -->
