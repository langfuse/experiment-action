"""
Langfuse experiment runner wrapper.

Invoked as:
    python python_runner.py <user_script_path> <result_file> <status_file>

Contract:
  - Imports the user script as a module
  - Creates a Langfuse ``RunnerContext`` from action inputs
  - Calls its ``experiment(context)`` function
  - Serializes the returned result to ``<result_file>`` as JSON
  - Writes a single-line JSON status envelope to ``<status_file>`` with
    ``{"status": "ok"}`` or
    ``{"status": "error", "error_name": "...", "message": "...", "is_regression": bool, "traceback": "..."}``

The wrapper's own exit code is always 0 — the action reads ``<status_file>``
to decide pass/fail. This keeps error reporting structured regardless of
how Python chose to surface the exception (stderr ordering, buffered output,
SIGPIPE, etc.).
"""

from __future__ import annotations

import asyncio
import importlib.util
import inspect
import json
import os
import sys
import traceback
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


@dataclass
class Status:
    """JSON envelope written to <status_file>.

    The TypeScript side reads this as ``StatusFile`` in
    ``src/executors/shared.ts`` — keep the field names in sync there.
    """

    status: str
    error_name: str = ""
    message: str = ""
    is_regression: bool = False
    traceback: str = ""

    @classmethod
    def ok(cls) -> "Status":
        return cls(status="ok")

    @classmethod
    def from_exception(cls, exc: BaseException) -> "Status":
        name = type(exc).__name__
        return cls(
            status="error",
            error_name=name,
            message=str(exc),
            is_regression=name == "RegressionError",
            traceback=traceback.format_exc(),
        )

    @classmethod
    def contract_error(cls, message: str) -> "Status":
        return cls(status="error", error_name="ContractError", message=message)

    @classmethod
    def serialization_error(cls, exc: BaseException) -> "Status":
        return cls(
            status="error",
            error_name="SerializationError",
            message=f"Could not serialize experiment result: {exc!r}",
            traceback=traceback.format_exc(),
        )


def _serialize(value: Any) -> Any:
    """Best-effort serialization of the user's ExperimentResult."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return [_serialize(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _serialize(v) for k, v in value.items()}

    # Pydantic v2
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        try:
            return _serialize(model_dump())
        except Exception:
            pass

    # dataclasses / attrs / anything with __dict__
    if hasattr(value, "__dict__"):
        try:
            return _serialize(
                {k: v for k, v in vars(value).items() if not k.startswith("_")}
            )
        except Exception:
            pass

    return repr(value)


def _write_status(status_file: Path, status: Status) -> None:
    status_file.write_text(json.dumps(asdict(status)), encoding="utf-8")


def _write_result(result_file: Path, value: Any) -> None:
    result_file.write_text(json.dumps(_serialize(value)), encoding="utf-8")


async def _await(awaitable: Any) -> Any:
    """Wrap a non-coroutine awaitable so asyncio.run can drive it."""
    return await awaitable


def _parse_dataset_version(raw: str | None) -> datetime | None:
    if not raw:
        return None
    return datetime.fromisoformat(raw.replace("Z", "+00:00"))


def _create_runner_context() -> Any:
    # Keep SDK imports local so malformed scripts can still fail with a
    # structured ContractError before importing langfuse. SDK import/setup
    # failures then stay inside the execution path and are written to the
    # status file like user-code errors.
    from langfuse import RunnerContext, get_client  # type: ignore[attr-defined]

    client = get_client()
    metadata_raw = os.environ.get("LANGFUSE_EXPERIMENT_METADATA")
    metadata = json.loads(metadata_raw) if metadata_raw else None
    dataset_name = os.environ.get("LANGFUSE_DATASET_NAME")
    dataset_version = _parse_dataset_version(os.environ.get("LANGFUSE_DATASET_VERSION"))
    data = None

    if dataset_name:
        dataset = client.get_dataset(
            dataset_name,
            version=dataset_version,
        )
        data = dataset.items

    return RunnerContext(
        client=client,
        data=data,
        dataset_version=dataset_version,
        metadata=metadata,
    )


def _flush_langfuse(context: Any | None) -> None:
    if context is None:
        return

    try:
        result = context.client.flush()
        if inspect.isawaitable(result):
            asyncio.run(_await(result))
    except Exception as exc:
        sys.stderr.write(f"::debug::Langfuse Python flush failed: {exc!r}\n")


def _has_context_parameter(experiment_fn: Any) -> bool:
    try:
        signature = inspect.signature(experiment_fn)
    except (TypeError, ValueError):
        return False

    params = signature.parameters
    context = params.get("context")
    if context is None:
        return False
    if context.kind not in (
        inspect.Parameter.POSITIONAL_OR_KEYWORD,
        inspect.Parameter.KEYWORD_ONLY,
    ):
        return False

    for name, param in params.items():
        if name == "context":
            continue
        if param.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD):
            continue
        if param.default is inspect.Parameter.empty:
            return False

    return True


def _load_user_module(script_path: Path) -> Any:
    module_name = "langfuse_user_experiment"
    spec = importlib.util.spec_from_file_location(module_name, script_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Could not load module from {str(script_path)!r}.")
    module = importlib.util.module_from_spec(spec)
    # Make sibling files importable (helper modules next to the script).
    script_dir = str(script_path.resolve().parent)
    if script_dir not in sys.path:
        sys.path.insert(0, script_dir)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    if len(sys.argv) != 4:
        sys.stderr.write(
            "python_runner.py: expected <script> <result_file> <status_file>\n"
        )
        return 2

    script_path = Path(sys.argv[1])
    result_file = Path(sys.argv[2])
    status_file = Path(sys.argv[3])

    try:
        module = _load_user_module(script_path)
    except Exception as exc:
        _write_status(status_file, Status.from_exception(exc))
        return 0

    experiment_fn = getattr(module, "experiment", None)
    if not callable(experiment_fn):
        _write_status(
            status_file,
            Status.contract_error(
                "Script does not define a callable `experiment()` function. "
                "See https://github.com/langfuse/experiment-action#script-contract"
            ),
        )
        return 0

    if not _has_context_parameter(experiment_fn):
        _write_status(
            status_file,
            Status.contract_error(
                "Script `experiment` function must accept a `context` parameter. "
                "See https://github.com/langfuse/experiment-action#script-contract"
            ),
        )
        return 0

    context = None
    try:
        context = _create_runner_context()
        result = experiment_fn(context=context)
        # `async def experiment()` returns a coroutine; `def experiment()`
        # that returns a Future/Task is also awaitable. Await both shapes
        # so the experiment body actually runs (and its exceptions surface
        # to the except block below).
        if inspect.isawaitable(result):
            result = asyncio.run(_await(result))
    except Exception as exc:
        # RegressionError carries a .result attribute — capture it if present.
        embedded_result = getattr(exc, "result", None)
        if embedded_result is not None:
            try:
                _write_result(result_file, embedded_result)
            except Exception:
                pass
        _write_status(status_file, Status.from_exception(exc))
        return 0
    finally:
        _flush_langfuse(context)

    try:
        _write_result(result_file, result)
    except Exception as exc:
        _write_status(status_file, Status.serialization_error(exc))
        return 0

    _write_status(status_file, Status.ok())
    return 0


if __name__ == "__main__":
    sys.exit(main())
