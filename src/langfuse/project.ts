import * as core from "@actions/core";

/**
 * Resolve the Langfuse project id from the action's API credentials. A
 * public/secret key pair is scoped to exactly one project, so the first
 * entry of `/api/public/projects` is it.
 *
 * Returns `null` on any failure — the caller falls back to not rendering
 * the "View on Langfuse" link rather than blowing up.
 */
export async function resolveProjectId(params: {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
}): Promise<string | null> {
  const { baseUrl, publicKey, secretKey } = params;
  if (!baseUrl || !publicKey || !secretKey) return null;

  try {
    const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
    const res = await fetch(`${stripTrailingSlash(baseUrl)}/api/public/projects`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!res.ok) {
      core.debug(`resolveProjectId: /api/public/projects returned ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const id = body.data?.[0]?.id ?? null;
    core.debug(`resolveProjectId: ${id ?? "<unresolved>"}`);
    return id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.debug(`resolveProjectId failed: ${msg}`);
    return null;
  }
}

/**
 * Build the Langfuse UI link to an experiment's results page.
 *   <base>/project/<project_id>/experiments/results?baseline=<experiment_id>
 */
export function buildExperimentResultsUrl(params: {
  baseUrl: string;
  projectId: string;
  experimentId: string;
}): string {
  const { baseUrl, projectId, experimentId } = params;
  const base = stripTrailingSlash(baseUrl);
  return `${base}/project/${encodeURIComponent(projectId)}/experiments/results?baseline=${encodeURIComponent(experimentId)}`;
}

export function buildDatasetItemUrl(params: {
  baseUrl: string;
  projectId: string;
  datasetName: string;
  itemId: string;
}): string {
  const { baseUrl, projectId, datasetName, itemId } = params;
  const base = stripTrailingSlash(baseUrl);
  return `${base}/project/${encodeURIComponent(projectId)}/datasets/${encodeURIComponent(datasetName)}/items/${encodeURIComponent(itemId)}`;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
