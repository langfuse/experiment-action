// Langfuse experiment runner wrapper (Node / tsx).
//
// Invoked as:
//     <install-dir>/node_modules/.bin/tsx ./node_runner.mjs <user_script> <result_file> <status_file>
//
// Mirrors python_runner.py: always exits 0, writes status envelope to
// <status_file> and result JSON to <result_file>.

import { register } from "node:module";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";

// Register an ESM resolver for `@langfuse/*`, `@opentelemetry/*`, and
// `tsx` that resolves them from our stable install dir. Needed because
// ESM resolution ignores NODE_PATH — without this, `import "@langfuse/client"`
// from the user's script fails unless their repo already has it in a
// local `node_modules`. Registered *before* we dynamic-import the user
// script so the hook applies to that import tree.
if (process.env.LANGFUSE_ACTION_INSTALL_DIR) {
  register(new URL("./node_resolver.mjs", import.meta.url), import.meta.url);
}

async function writeStatus(statusFile, payload) {
  await writeFile(statusFile, JSON.stringify(payload), "utf8");
}

async function writeErrorStatus(statusFile, err, overrides = {}) {
  const e = serializeError(err);
  await writeStatus(statusFile, {
    status: "error",
    error_name: overrides.error_name ?? e.name,
    message: overrides.message ?? e.message,
    is_regression: overrides.is_regression ?? e.isRegression,
    traceback: overrides.traceback ?? e.stack,
  });
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
    await writeErrorStatus(statusFile, err);
    return;
  }

  const experimentFn = mod.experiment ?? mod.default?.experiment ?? mod.default;
  if (typeof experimentFn !== "function") {
    await writeErrorStatus(statusFile, new Error("ContractError"), {
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
    await writeErrorStatus(statusFile, err);
    return;
  }

  try {
    await writeFile(resultFile, JSON.stringify(result ?? null), "utf8");
  } catch (err) {
    await writeErrorStatus(statusFile, err, {
      error_name: "SerializationError",
      message: `Could not serialize experiment result: ${serializeError(err).message}`,
      is_regression: false,
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
      await writeErrorStatus(statusFile, err);
    }
  } catch {
    /* ignore */
  }
  process.exit(0);
});
