import * as path from "node:path";

import type { RunnerEnv } from "@/executors/shared";
import type { RawScriptResult, Runtime } from "@/types";

/**
 * An experiment script discovered on disk. Subclasses implement `run()` for
 * the specific runtime (Python, Node).
 */
export abstract class ExperimentScript {
  constructor(public readonly path: string) {}

  abstract readonly runtime: Runtime;

  abstract run(env: RunnerEnv): Promise<RawScriptResult>;

  /** The script's filename without directory — used in PR comments and logs. */
  get name(): string {
    return path.basename(this.path);
  }
}
