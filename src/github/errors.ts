export function errorStatus(err: unknown): number | undefined {
  return typeof (err as { status?: unknown }).status === "number"
    ? (err as { status: number }).status
    : undefined;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
