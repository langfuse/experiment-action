<!-- langfuse-experiment-action run_id=12345 -->

# <img src="https://langfuse.com/brand-assets/icon/color/langfuse-icon.png" height="32" alt="" align="center" /> Experiment Results: `abc1234`

<!-- langfuse-experiment-action:overview:start -->
| Experiment | Status | Actions |
| --- | --- | --- |
| Uppercase task | ✅ Pass | [View GitHub Action Run](https://github.com/owner/repo/actions/runs/7/job/42) · [View in Langfuse](http://localhost:3000/project/7a88fb47-b4e2-43b8-a06c-a5ce950dc53a/experiments/results?baseline=0f212f9182320769) |
<!-- langfuse-experiment-action:overview:end -->

**Details**

<!-- langfuse-experiment-action:start script=%2Ftmp%2Fexperiment.py -->
<!-- langfuse-experiment-action:actions run=https%3A%2F%2Fgithub.com%2Fowner%2Frepo%2Factions%2Fruns%2F7%2Fjob%2F42 langfuse=http%3A%2F%2Flocalhost%3A3000%2Fproject%2F7a88fb47-b4e2-43b8-a06c-a5ce950dc53a%2Fexperiments%2Fresults%3Fbaseline%3D0f212f9182320769 -->
<details><summary>✅ Uppercase task</summary>

Script: `tmp/experiment.py`

| Score | Value |
| --- | --- |
| `avg_accuracy` | 1.000 |

<details><summary>Item results (2)</summary>

| Item | Input | Expected | Output | exact_match |
| --- | --- | --- | --- | --- |
| 1 | hello | HELLO | HELLO | 1.000 |
| dataset-item-42 | world | WORLD | WORLD | 1.000 |

</details>

</details>
<br>
<!-- langfuse-experiment-action:end script=%2Ftmp%2Fexperiment.py -->
