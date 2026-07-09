<!-- langfuse-experiment-action run_id=12345 -->

### <img src="https://langfuse.com/brand-assets/icon/color/langfuse-icon.png" height="32" alt="" align="center" /> Experiment Results: `abc1234` (#2)

<!-- langfuse-experiment-action:overview:start -->
| Experiment | Status | Actions |
| --- | --- | --- |
| Uppercase task | ✅ Pass | Local dataset |
| Mixed dir (node) | ✅ Pass | Local dataset |
<!-- langfuse-experiment-action:overview:end -->

<!-- langfuse-experiment-action:details:start -->
**Details**
<!-- langfuse-experiment-action:details:end -->

<!-- langfuse-experiment-action:start/2 script=%2Ftmp%2Fexperiment.py job= local_dataset=true -->
<details><summary>✅ Uppercase task</summary>

<br>

| Score | Value |
| --- | --- |
| `avg_accuracy` | 1.000 |

<details><summary>Item results (2)</summary>

| Item | Input | Expected | Output | exact_match |
| --- | --- | --- | --- | --- |
| 1 | hello | HELLO | HELLO | 1.000 |
| 2 | world | WORLD | WORLD | 1.000 |

</details>

</details>
<!-- langfuse-experiment-action:end/2 script=%2Ftmp%2Fexperiment.py job= -->

<!-- langfuse-experiment-action:start/2 script=%2Ftmp%2Fmixed%2Fexp_node.ts job= local_dataset=true -->
<details><summary>✅ Mixed dir (node)</summary>

<br>

| Score | Value |
| --- | --- |
| `avg_accuracy` | 0.830 |

<details><summary>Item results (1)</summary>

| Item | Input | Expected | Output | exact_match |
| --- | --- | --- | --- | --- |
| 1 | node | NODE | NODE | 1.000 |

</details>

</details>
<!-- langfuse-experiment-action:end/2 script=%2Ftmp%2Fmixed%2Fexp_node.ts job= -->
