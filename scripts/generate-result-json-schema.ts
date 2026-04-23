import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { toJsonSchema } from "@valibot/to-json-schema";
import prettier from "prettier";

import { outputEnvelopeSchema } from "../src/schema/output";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.resolve(__dirname, "../schemas/result-json.v1.schema.json");

async function main(): Promise<void> {
  const jsonSchema = toJsonSchema(outputEnvelopeSchema, {
    target: "draft-2020-12",
    errorMode: "throw",
  }) as Record<string, unknown>;

  const document = {
    ...jsonSchema,
    $id: "https://github.com/langfuse/experiment-action/schemas/result-json.v1.schema.json",
    title: "Langfuse Experiment Action result_json v1",
  };

  const serialized = JSON.stringify(document, null, 2);
  const formatted = await prettier.format(serialized, {
    filepath: outputPath,
  });

  await fs.writeFile(outputPath, formatted, "utf8");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
