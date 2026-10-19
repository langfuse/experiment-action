// Custom ESM resolver registered by node_runner.mjs.
//
// ESM resolution ignores NODE_PATH: when a user experiment script does
// `import "@langfuse/client"`, Node walks up from *the script's* URL
// looking for a `node_modules/@langfuse/client` — not from our stable
// install dir under $RUNNER_TEMP. This hook intercepts the packages we
// manage (@langfuse/*, @opentelemetry/*, tsx) and asks Node to resolve
// them as if the import came from inside our install dir.

import { pathToFileURL } from "node:url";
import { join } from "node:path";

const INSTALL_DIR = process.env.LANGFUSE_ACTION_INSTALL_DIR;
// A synthetic URL inside the install dir. Node's resolver walks upward
// from here, finds `<INSTALL_DIR>/node_modules/<pkg>`, and returns it.
const FAKE_PARENT_URL = INSTALL_DIR
  ? pathToFileURL(join(INSTALL_DIR, "__langfuse_entry.mjs")).href
  : null;

const MANAGED_PREFIXES = ["@langfuse/", "@opentelemetry/"];
const MANAGED_EXACT = new Set(["tsx"]);

function isManaged(specifier) {
  if (MANAGED_EXACT.has(specifier)) return true;
  return MANAGED_PREFIXES.some((prefix) => specifier.startsWith(prefix));
}

export async function resolve(specifier, context, nextResolve) {
  if (FAKE_PARENT_URL && isManaged(specifier)) {
    try {
      return await nextResolve(specifier, { ...context, parentURL: FAKE_PARENT_URL });
    } catch {
      // Fall through to normal resolution so user-owned copies still win
      // if the action happens to run in a repo that vendors these.
    }
  }
  return nextResolve(specifier, context);
}
