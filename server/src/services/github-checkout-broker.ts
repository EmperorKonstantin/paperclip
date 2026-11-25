type CheckoutScope = {
  companyId: string;
  projectId: string;
  workspaceId: string;
  repositoryId: string;
};

export type GitHubInstallationScope = CheckoutScope & { repository: string } & (
  | { operation: "checkout"; agentId?: string; issueId?: string }
  | { operation: "write"; agentId: string; issueId: string; runId: string }
);

type BrokerOptions = {
  endpoint: string;
  serviceToken: string;
  timeoutMs?: number;
};

const MAX_RESPONSE_BYTES = 8192;
const MAX_TOKEN_LIFETIME_MS = 61 * 60 * 1000;

export class GitHubCheckoutBrokerError extends Error {
  constructor(readonly code: "invalid_configuration" | "denied" | "unavailable" | "invalid_response") {
    super("GitHub checkout credential broker: " + code.replaceAll("_", " "));
  }
}

async function readCredentialResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new GitHubCheckoutBrokerError("invalid_response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new GitHubCheckoutBrokerError("invalid_response");
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new GitHubCheckoutBrokerError("invalid_response");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Obtain a repository-scoped token after the caller authorizes a workspace or active run. */
export async function requestGitHubInstallationCredential(options: BrokerOptions, request: GitHubInstallationScope): Promise<string> {
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpoint);
  } catch {
    throw new GitHubCheckoutBrokerError("invalid_configuration");
  }
  const loopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
  if ((endpoint.protocol !== "https:" && !(loopback && endpoint.protocol === "http:"))
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !/^[A-Za-z0-9._~-]{32,1024}$/.test(options.serviceToken)) {
    throw new GitHubCheckoutBrokerError("invalid_configuration");
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.serviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const denied = [401, 403, 404].includes(response.status);
      throw new GitHubCheckoutBrokerError(denied ? "denied" : "unavailable");
    }
    const payload = await readCredentialResponse(response);
    if (!payload || typeof payload !== "object") throw new GitHubCheckoutBrokerError("invalid_response");
    const { token, expiresAt, scope: returnedScope } = payload as {
      token?: unknown;
      expiresAt?: unknown;
      scope?: Partial<typeof request>;
    };
    const expires = typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
    const lifetime = expires - Date.now();
    if (typeof token !== "string" || !/^ghs_[\x21-\x7e]{1,4092}$/.test(token)
      || !Number.isFinite(lifetime) || lifetime <= 0 || lifetime > MAX_TOKEN_LIFETIME_MS
      || Object.entries(request).some(([key, value]) => returnedScope?.[key as keyof typeof request] !== value)) {
      throw new GitHubCheckoutBrokerError("invalid_response");
    }
    return token;
  } catch (error) {
    if (error instanceof GitHubCheckoutBrokerError) throw error;
    // Transport failures can include response content or request headers.
    throw new GitHubCheckoutBrokerError("unavailable");
  }
}
