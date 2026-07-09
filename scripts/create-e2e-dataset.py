"""Create the Langfuse dataset used by the CI e2e jobs.

Reads its parameters from environment variables so the composite action
(.github/actions/e2e-setup) can pass per-job values:

  DATASET_NAME          name of the dataset to create
  DATASET_DESCRIPTION   dataset description
  DATASET_ITEMS         JSON array of {"input": ..., "expected_output": ...}

Langfuse credentials come from the standard LANGFUSE_PUBLIC_KEY,
LANGFUSE_SECRET_KEY, and LANGFUSE_BASE_URL environment variables.
"""

import json
import os

from langfuse import Langfuse


def main() -> None:
    client = Langfuse(
        public_key=os.environ["LANGFUSE_PUBLIC_KEY"],
        secret_key=os.environ["LANGFUSE_SECRET_KEY"],
        host=os.environ["LANGFUSE_BASE_URL"],
    )
    dataset_name = os.environ["DATASET_NAME"]
    client.create_dataset(
        name=dataset_name,
        description=os.environ["DATASET_DESCRIPTION"],
    )
    for item in json.loads(os.environ["DATASET_ITEMS"]):
        client.create_dataset_item(
            dataset_name=dataset_name,
            input=item["input"],
            expected_output=item["expected_output"],
        )
    client.flush()


if __name__ == "__main__":
    main()
