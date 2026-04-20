// Langfuse experiment runner wrapper (Node / tsx).
//
// Invoked as:
//     node --import tsx ./node_runner.mjs <user_script> <result_file> <status_file>
//
// Mirrors python_runner.py: always exits 0, writes status envelope to
// <status_file> and result JSON to <result_file>.

import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";

async function writeStatus(statusFile, payload) {
  await writeFile(statusFile, JSON.stringify(payload), "utf8");
}

function serializeError(err) {
  if (err instanceof Error) {
    const name = err.name || err.constructor?.name || "Error";
    return {
      name,
      message: err.message ?? String(err),
      stack: err.stack ?? "",
      isRegression: name === "RegressionError",
    };
  }
  return {
    name: "NonErrorThrown",
    message: typeof err === "string" ? err : JSON.stringify(err),
    stack: "",
    isRegression: false,
  };
}

async function main() {
  const [, , scriptPath, resultFile, statusFile] = process.argv;
  if (!scriptPath || !resultFile || !statusFile) {
    process.stderr.write("node_runner.mjs: expected <script> <result_file> <status_file>\n");
    process.exit(2);
  }

  const absScript = resolvePath(scriptPath);
  let mod;
  try {
    mod = await import(pathToFileURL(absScript).href);
  } catch (err) {
    const e = serializeError(err);
    await writeStatus(statusFile, {
      status: "error",
      error_name: e.name,
      message: e.message,
      is_regression: e.isRegression,
      traceback: e.stack,
    });
    return;
  }

  const experimentFn = mod.experiment ?? mod.default?.experiment ?? mod.default;
  if (typeof experimentFn !== "function") {
    await writeStatus(statusFile, {
      status: "error",
      error_name: "ContractError",
      message:
        "Script does not export a callable `experiment` function. " +
        "See https://github.com/langfuse/experiment-action#script-contract",
      is_regression: false,
      traceback: "",
    });
    return;
  }

  let result;
  try {
    result = await experimentFn();
  } catch (err) {
    const e = serializeError(err);
    const embeddedResult = err && typeof err === "object" ? err.result : undefined;
    if (embeddedResult !== undefined) {
      try {
        await writeFile(resultFile, JSON.stringify(embeddedResult), "utf8");
      } catch {
        /* best-effort */
      }
    }
    await writeStatus(statusFile, {
      status: "error",
      error_name: e.name,
      message: e.message,
      is_regression: e.isRegression,
      traceback: e.stack,
    });
    return;
  }

  try {
    await writeFile(resultFile, JSON.stringify(result ?? null), "utf8");
  } catch (err) {
    const e = serializeError(err);
    await writeStatus(statusFile, {
      status: "error",
      error_name: "SerializationError",
      message: `Could not serialize experiment result: ${e.message}`,
      is_regression: false,
      traceback: e.stack,
    });
    return;
  }

  await writeStatus(statusFile, { status: "ok" });
}

main().catch(async (err) => {
  // Last-ditch guard — should not normally hit this.
  try {
    const statusFile = process.argv[4];
    if (statusFile) {
      const e = serializeError(err);
      await writeStatus(statusFile, {
        status: "error",
        error_name: e.name,
        message: e.message,
        is_regression: e.isRegression,
        traceback: e.stack,
      });
    }
  } catch {
    /* ignore */
  }
  process.exit(0);
});
