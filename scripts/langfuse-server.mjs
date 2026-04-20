#!/usr/bin/env node
// Manage a local Langfuse instance via docker compose for e2e tests.
//
//   node scripts/langfuse-server.mjs up     - pull compose file, start containers
//   node scripts/langfuse-server.mjs wait   - poll /api/public/health + check seed project
//   node scripts/langfuse-server.mjs down   - tear down + remove volumes
//
// The LANGFUSE_INIT_* env vars below seed a project on first boot, so the
// credentials in `.env.example` work immediately after `pnpm run dev`.

import { spawn, execSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const serverDir = join(repoRoot, "langfuse-server");

const SEED_PROJECT = {
  LANGFUSE_INIT_ORG_ID: "0c6c96f4-0ca0-4f16-92a8-6dd7d7c6a501",
  LANGFUSE_INIT_ORG_NAME: "Experiment Action Test Org",
  LANGFUSE_INIT_PROJECT_ID: "7a88fb47-b4e2-43b8-a06c-a5ce950dc53a",
  LANGFUSE_INIT_PROJECT_NAME: "Experiment Action Test Project",
  LANGFUSE_INIT_PROJECT_PUBLIC_KEY: "pk-lf-1234567890",
  LANGFUSE_INIT_PROJECT_SECRET_KEY: "sk-lf-1234567890",
  LANGFUSE_INIT_USER_EMAIL: "experiment-action@langfuse.local",
  LANGFUSE_INIT_USER_NAME: "Experiment Action Tests",
  LANGFUSE_INIT_USER_PASSWORD: "langfuse-ci-password",
};

const SERVER_TUNING = {
  TELEMETRY_ENABLED: "false",
  NEXT_PUBLIC_LANGFUSE_RUN_NEXT_INIT: "true",
  LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT: "http://localhost:9090",
  LANGFUSE_INGESTION_QUEUE_DELAY_MS: "10",
  LANGFUSE_INGESTION_CLICKHOUSE_WRITE_INTERVAL_MS: "10",
  LANGFUSE_EXPERIMENT_INSERT_INTO_EVENTS_TABLE: "true",
  QUEUE_CONSUMER_EVENT_PROPAGATION_QUEUE_IS_ENABLED: "true",
  LANGFUSE_ENABLE_EVENTS_TABLE_V2_APIS: "true",
  LANGFUSE_ENABLE_EVENTS_TABLE_OBSERVATIONS: "true",
};

const [, , cmd] = process.argv;

switch (cmd) {
  case "up":
    await up();
    break;
  case "wait":
    await waitForHealth();
    break;
  case "down":
    await down();
    break;
  default:
    console.error("usage: langfuse-server.mjs <up|wait|down>");
    process.exit(2);
}

async function up() {
  await mkdir(serverDir, { recursive: true });
  const sha = execSync("git ls-remote https://github.com/langfuse/langfuse.git HEAD", {
    encoding: "utf8",
  })
    .split("\t")[0]
    .trim();
  console.log(`Downloading docker-compose.yml from langfuse@${sha}`);
  const res = await fetch(
    `https://raw.githubusercontent.com/langfuse/langfuse/${sha}/docker-compose.yml`,
  );
  if (!res.ok) throw new Error(`Could not download compose file: HTTP ${res.status}`);
  await writeFile(join(serverDir, "docker-compose.yml"), await res.text());

  const env = { ...process.env, ...SERVER_TUNING, ...SEED_PROJECT };
  await run("docker", ["compose", "up", "-d"], { cwd: serverDir, env });
  console.log("Langfuse containers started. Run `pnpm run dev:wait` to block until healthy.");
}

async function waitForHealth() {
  const baseUrl = process.env.LANGFUSE_BASE_URL ?? "http://localhost:3000";
  const publicKey =
    process.env.LANGFUSE_PUBLIC_KEY ?? SEED_PROJECT.LANGFUSE_INIT_PROJECT_PUBLIC_KEY;
  const secretKey =
    process.env.LANGFUSE_SECRET_KEY ?? SEED_PROJECT.LANGFUSE_INIT_PROJECT_SECRET_KEY;
  const projectId = SEED_PROJECT.LANGFUSE_INIT_PROJECT_ID;
  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");

  const maxAttempts = 40;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const health = await fetch(`${baseUrl}/api/public/health`);
      if (health.ok) {
        const projects = await fetch(`${baseUrl}/api/public/projects`, {
          headers: { Authorization: `Basic ${auth}` },
        });
        if (projects.ok) {
          const body = await projects.json();
          const match = body.data?.find((p) => p.id === projectId);
          if (match) {
            console.log(`Langfuse healthy; seed project ${match.id} is ready.`);
            return;
          }
        }
      }
    } catch {
      /* server still coming up */
    }
    console.log(`Waiting for Langfuse... (${attempt}/${maxAttempts})`);
    await new Promise((r) => setTimeout(r, 5000));
  }

  console.error("Langfuse did not become healthy in time. Dumping container state:");
  try {
    execSync("docker compose ps", { cwd: serverDir, stdio: "inherit" });
    execSync("docker compose logs langfuse-web langfuse-worker", {
      cwd: serverDir,
      stdio: "inherit",
    });
  } catch {
    /* best-effort */
  }
  process.exit(1);
}

async function down() {
  try {
    await run("docker", ["compose", "down", "-v"], { cwd: serverDir });
  } catch (err) {
    console.warn(`docker compose down failed: ${err.message}`);
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`)),
    );
  });
}
