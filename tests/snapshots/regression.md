<!-- langfuse-experiment-action run_id=12345 -->

# <img src="https://langfuse.com/brand-assets/icon/color/langfuse-icon.png" height="32" alt="" align="center" /> Experiment Results: `abc1234`

<!-- langfuse-experiment-action:overview:start -->
| Experiment | Status | Actions |
| --- | --- | --- |
| Regression fixture | ❌ Regression | [View GitHub Action Run](https://github.com/o/r/actions/runs/7/job/42) |
<!-- langfuse-experiment-action:overview:end -->

**Details**

<!-- langfuse-experiment-action:start script=%2Ftmp%2Freg.py -->
<!-- langfuse-experiment-action:actions run=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Factions%2Fruns%2F7%2Fjob%2F42 -->
<details open><summary>❌ Regression fixture</summary>

Script: `tmp/reg.py`

> **RegressionError:** accuracy dropped to 0.5

| Score | Value |
| --- | --- |
| `avg_accuracy` | 0.500 |

<details><summary>Item results (1)</summary>

| Item | Input | Expected | Output | exact_match |
| --- | --- | --- | --- | --- |
| 1 | x | X | X | 1.000 |

</details>

</details>
<br>
<!-- langfuse-experiment-action:end script=%2Ftmp%2Freg.py -->
