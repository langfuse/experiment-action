import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const NODE_WRAPPER = path.join(root, "src", "executors", "wrappers", "node_runner.mjs");
const PYTHON_WRAPPER = path.join(root, "src", "executors", "wrappers", "python_runner.py");
const CONTRACT_URL = "https://github.com/langfuse/experiment-action#script-contract";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "langfuse-wrapper-test-"));
}

function wrapperFiles(tmp: string): { resultFile: string; statusFile: string } {
  return {
    resultFile: path.join(tmp, "result.json"),
    statusFile: path.join(tmp, "status.json"),
  };
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function runNodeWrapper(opts: {
  scriptPath: string;
  resultFile: string;
  statusFile: string;
  env?: Record<string, string>;
}): Promise<void> {
  await execFileAsync(
    process.execPath,
    [NODE_WRAPPER, opts.scriptPath, opts.resultFile, opts.statusFile],
    {
      env: { ...process.env, ...opts.env },
    },
  );
}

async function runPythonWrapper(opts: {
  scriptPath: string;
  resultFile: string;
  statusFile: string;
  env?: Record<string, string>;
}): Promise<void> {
  await execFileAsync(
    "python",
    [PYTHON_WRAPPER, opts.scriptPath, opts.resultFile, opts.statusFile],
    {
      env: { ...process.env, ...opts.env },
    },
  );
}

function contractError(message: string): Record<string, unknown> {
  return {
    status: "error",
    error_name: "ContractError",
    message: `${message} See ${CONTRACT_URL}`,
    is_regression: false,
    traceback: "",
  };
}

async function installFakeNodeRuntime(tmp: string): Promise<{
  installDir: string;
  otelEventsFile: string;
}> {
  const installDir = path.join(tmp, "install");
  const fakeClientDir = path.join(installDir, "node_modules", "@langfuse", "client");
  const fakeOtelDir = path.join(installDir, "node_modules", "@langfuse", "otel");
  const fakeSdkNodeDir = path.join(installDir, "node_modules", "@opentelemetry", "sdk-node");
  await fs.mkdir(fakeClientDir, { recursive: true });
  await fs.mkdir(fakeOtelDir, { recursive: true });
  await fs.mkdir(fakeSdkNodeDir, { recursive: true });

  const realClientDir = await fs.realpath(path.join(root, "node_modules", "@langfuse", "client"));
  const realRuntimeNodeModules = path.dirname(path.dirname(realClientDir));
  await fs.symlink(
    path.join(realRuntimeNodeModules, "@langfuse", "core"),
    path.join(installDir, "node_modules", "@langfuse", "core"),
    "dir",
  );
  await fs.symlink(
    path.join(realRuntimeNodeModules, "@langfuse", "tracing"),
    path.join(installDir, "node_modules", "@langfuse", "tracing"),
    "dir",
  );
  await fs.symlink(
    path.join(realRuntimeNodeModules, "@opentelemetry", "api"),
    path.join(installDir, "node_modules", "@opentelemetry", "api"),
    "dir",
  );

  await fs.writeFile(path.join(fakeClientDir, "package.json"), JSON.stringify({ type: "module" }));
  await fs.writeFile(path.join(fakeOtelDir, "package.json"), JSON.stringify({ type: "module" }));
  await fs.writeFile(path.join(fakeSdkNodeDir, "package.json"), JSON.stringify({ type: "module" }));
  await fs.writeFile(path.join(fakeOtelDir, "index.js"), `export class LangfuseSpanProcessor {}`);
  await fs.writeFile(
    path.join(fakeSdkNodeDir, "index.js"),
    `import { appendFileSync } from "node:fs";
    export class NodeSDK {
      constructor() { this.started = false; }
      start() {
        this.started = true;
        appendFileSync(process.env.LANGFUSE_OTEL_TEST_EVENTS, "start\\n");
      }
      async shutdown() {
        this.started = false;
        appendFileSync(process.env.LANGFUSE_OTEL_TEST_EVENTS, "shutdown\\n");
      }
    }`,
  );
  const realClientEntry = pathToFileURL(
    path.join(root, "node_modules", "@langfuse", "client", "dist", "index.mjs"),
  ).href;
  await fs.writeFile(
    path.join(fakeClientDir, "index.js"),
    `export { RunnerContext, RegressionError } from ${JSON.stringify(realClientEntry)};
    export class LangfuseClient {
      constructor() {
        this.dataset = {
          get: async (name, options) => ({
            items: [{ input: name, expectedOutput: options?.version ?? null }],
          }),
        };
        this.experiment = {
          run: async (params) => params,
        };
      }
    }`,
  );

  return { installDir, otelEventsFile: path.join(tmp, "otel-events.txt") };
}

async function installFakePythonLangfuse(tmp: string): Promise<{ flushEventsFile: string }> {
  await fs.writeFile(
    path.join(tmp, "langfuse.py"),
    `class Dataset:
    def __init__(self, name, version):
        self.items = [{"input": name, "expected_output": version.isoformat() if version else None}]

class Client:
    def get_dataset(self, name, *, version=None):
        return Dataset(name, version)

    def flush(self):
        with open(__import__("os").environ["LANGFUSE_PY_FLUSH_TEST_EVENTS"], "a") as file:
            file.write("flush\\n")

def get_client():
    return Client()

class RunnerContext:
    def __init__(self, *, client, data=None, dataset_version=None, metadata=None):
        self.client = client
        self.data = data
        self.dataset_version = dataset_version
        self.metadata = metadata

    def run_experiment(self, **params):
        return {
            "data": self.data,
            "dataset_version": self.dataset_version.isoformat() if self.dataset_version else None,
            "metadata": self.metadata,
            "params": params,
        }

class RegressionError(Exception):
    def __init__(self, *, result):
        super().__init__("regression")
        self.result = result
`,
  );
  return { flushEventsFile: path.join(tmp, "python-flush-events.txt") };
}

describe("experiment runner wrappers", () => {
  it("injects JS RunnerContext and manages OTel lifecycle", async () => {
    const tmp = await makeTmpDir();
    const { installDir, otelEventsFile } = await installFakeNodeRuntime(tmp);
    const { resultFile, statusFile } = wrapperFiles(tmp);
    const scriptPath = path.join(tmp, "experiment.mjs");
    await fs.writeFile(
      scriptPath,
      `import { appendFileSync } from "node:fs";
      export async function experiment(context = undefined, optional = "allowed") {
        appendFileSync(process.env.LANGFUSE_OTEL_TEST_EVENTS, "experiment\\n");
        return context.runExperiment({ name: "from-script", optional });
      }`,
    );

    await runNodeWrapper({
      scriptPath,
      resultFile,
      statusFile,
      env: {
        LANGFUSE_ACTION_INSTALL_DIR: installDir,
        LANGFUSE_DATASET_NAME: "ci-dataset",
        LANGFUSE_DATASET_VERSION: "2026-05-04T12:00:00Z",
        LANGFUSE_EXPERIMENT_METADATA: JSON.stringify({ source: "action" }),
        LANGFUSE_OTEL_TEST_EVENTS: otelEventsFile,
      },
    });

    expect(await readJson(statusFile)).toEqual({ status: "ok" });
    expect(await readJson(resultFile)).toEqual({
      name: "from-script",
      data: [{ input: "ci-dataset", expectedOutput: "2026-05-04T12:00:00Z" }],
      datasetVersion: "2026-05-04T12:00:00Z",
      metadata: { source: "action" },
      optional: "allowed",
    });
    expect(await fs.readFile(otelEventsFile, "utf8")).toBe("start\nexperiment\nshutdown\n");
  });

  it("returns a contract error when JS experiment omits the context parameter", async () => {
    const tmp = await makeTmpDir();
    const { resultFile, statusFile } = wrapperFiles(tmp);
    const scriptPath = path.join(tmp, "experiment.mjs");
    await fs.writeFile(scriptPath, `export async function experiment(foo) { return foo; }`);

    await runNodeWrapper({ scriptPath, resultFile, statusFile });

    expect(await readJson(statusFile)).toEqual(
      contractError("Script `experiment` function must accept `context` as its first parameter."),
    );
  });

  it("injects Python RunnerContext and flushes client", async () => {
    const tmp = await makeTmpDir();
    const { flushEventsFile } = await installFakePythonLangfuse(tmp);
    const { resultFile, statusFile } = wrapperFiles(tmp);
    const scriptPath = path.join(tmp, "experiment.py");
    await fs.writeFile(
      scriptPath,
      `from langfuse import RunnerContext

def experiment(context: RunnerContext, *args, optional="allowed", **kwargs):
    return context.run_experiment(name="from-script", optional=optional, args=args, kwargs=kwargs)
`,
    );

    await runPythonWrapper({
      scriptPath,
      resultFile,
      statusFile,
      env: {
        LANGFUSE_DATASET_NAME: "ci-dataset",
        LANGFUSE_DATASET_VERSION: "2026-05-04T12:00:00Z",
        LANGFUSE_EXPERIMENT_METADATA: JSON.stringify({ source: "action" }),
        LANGFUSE_PY_FLUSH_TEST_EVENTS: flushEventsFile,
      },
    });

    expect(await readJson(statusFile)).toEqual({
      status: "ok",
      error_name: "",
      message: "",
      is_regression: false,
      traceback: "",
    });
    expect(await readJson(resultFile)).toEqual({
      data: [{ input: "ci-dataset", expected_output: "2026-05-04T12:00:00+00:00" }],
      dataset_version: "2026-05-04T12:00:00+00:00",
      metadata: { source: "action" },
      params: { name: "from-script", optional: "allowed", args: [], kwargs: {} },
    });
    expect(await fs.readFile(flushEventsFile, "utf8")).toBe("flush\n");
  });

  it("returns a contract error when Python experiment omits the context parameter", async () => {
    const tmp = await makeTmpDir();
    const { resultFile, statusFile } = wrapperFiles(tmp);
    const scriptPath = path.join(tmp, "experiment.py");
    await fs.writeFile(scriptPath, `def experiment(foo):\n    return foo\n`);

    await runPythonWrapper({ scriptPath, resultFile, statusFile });

    expect(await readJson(statusFile)).toEqual(
      contractError("Script `experiment` function must accept a `context` parameter."),
    );
  });
});
