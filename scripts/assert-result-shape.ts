import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

import schema from "../schemas/result-json.v1.schema.json";

function main(): void {
  const raw = process.env.RESULT_JSON;
  if (!raw) {
    throw new Error("RESULT_JSON environment variable is required.");
  }

  const payload = JSON.parse(raw) as unknown;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  const validate = ajv.compile(schema);
  if (!validate(payload)) {
    const details = ajv.errorsText(validate.errors, { separator: "\n" });
    throw new Error(
      `result_json does not match the published output shape in schemas/result-json.v1.schema.json:\n${details}`,
    );
  }
}

try {
  main();
} catch (error: unknown) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
