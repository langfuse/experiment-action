import { execFileSync } from "node:child_process";

function run(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: "inherit" });
}

try {
  run(process.execPath, ["--import", "tsx", "scripts/generate-result-json-schema.ts"]);
  run("git", ["diff", "--quiet", "--exit-code", "--", "schemas/result-json.v1.schema.json"]);
} catch {
  process.stderr.write(
    [
      "Schema drift detected in schemas/result-json.v1.schema.json.",
      "To fix it:",
      "1. Update the runtime schema definitions under src/schema/ if needed.",
      "2. Run `pnpm run generate:schema`.",
      "3. Commit the updated schemas/result-json.v1.schema.json.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
