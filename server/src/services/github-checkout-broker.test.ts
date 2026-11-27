import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { requestGitHubInstallationCredential } from "./github-checkout-broker.js";

const scope = { operation: "checkout" as const, companyId: "company", projectId: "project", workspaceId: "workspace", repositoryId: "1234", repository: "example/repo" };
const serviceToken = "local-test-service-token-at-least-32";
const token = "ghs_012345_header.claims.signature";
const payload = {
  scope,
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  token,
};

async function withBroker(listener: RequestListener, run: (endpoint: string) => Promise<void>) {
  const server = createServer(listener);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test broker did not listen");
    await run(`http://127.0.0.1:${address.port}/checkout`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("GitHub checkout credential broker", () => {
  it("sends an authenticated checkout request and accepts a matching short-lived token", async () => {
    await withBroker(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const received = JSON.parse(Buffer.concat(chunks).toString());
      if (req.method !== "POST" || req.url !== "/checkout" || req.headers.authorization !== `Bearer ${serviceToken}`
        || JSON.stringify(received) !== JSON.stringify(payload.scope)) {
        res.writeHead(403).end();
        return;
      }
      res.end(JSON.stringify(payload));
    }, async (endpoint) => {
      await expect(requestGitHubInstallationCredential({ endpoint, serviceToken }, scope)).resolves.toBe(token);
    });
  });

  it.each([
    ["a different repository", { scope: { ...payload.scope, repositoryId: "5678" } }],
    ["a different company", { scope: { ...payload.scope, companyId: "other" } }],
    ["a different project", { scope: { ...payload.scope, projectId: "other" } }],
    ["a different workspace", { scope: { ...payload.scope, workspaceId: "other" } }],
    ["an expired credential", { expiresAt: "2000-01-01T00:00:00Z" }],
  ])("rejects %s", async (_, override) => {
    await withBroker((_, res) => {
      res.end(JSON.stringify({ ...payload, ...override }));
    }, async (endpoint) => {
      await expect(requestGitHubInstallationCredential({ endpoint, serviceToken }, scope))
        .rejects.toMatchObject({ code: "invalid_response" });
    });
  });

  it("gives an active run more time for authorization than workspace checkout", async () => {
    const writeScope = { ...scope, operation: "write" as const, agentId: "agent", issueId: "issue", runId: "run" };
    const deadline = vi.spyOn(AbortSignal, "timeout");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      return Response.json({ ...payload, scope: JSON.parse(String(init?.body)) });
    });
    try {
      const options = { endpoint: "https://broker.example.test", serviceToken };
      await expect(requestGitHubInstallationCredential(options, scope)).resolves.toBe(token);
      await expect(requestGitHubInstallationCredential(options, writeScope)).resolves.toBe(token);
      expect(deadline.mock.calls).toEqual([[5000], [8000]]);
    } finally {
      fetch.mockRestore();
      deadline.mockRestore();
    }
  });

  it("stops waiting on a stalled response body", async () => {
    await withBroker((_, res) => {
      res.write("{");
    }, async (endpoint) => {
      await expect(requestGitHubInstallationCredential({ endpoint, serviceToken, timeoutMs: 150 }, scope))
        .rejects.toMatchObject({ code: "timeout" });
    });
  });

  it("refuses redirects and keeps provider error bodies out of diagnostics", async () => {
    await withBroker((_, res) => {
      res.writeHead(302, { location: "/elsewhere" }).end(token);
    }, async (endpoint) => {
      await expect(requestGitHubInstallationCredential({ endpoint, serviceToken }, scope))
        .rejects.toMatchObject({ message: "GitHub checkout credential broker: unavailable" });
    });
    await withBroker((_, res) => {
      res.writeHead(403).end(token);
    }, async (endpoint) => {
      await expect(requestGitHubInstallationCredential({ endpoint, serviceToken }, scope))
        .rejects.toMatchObject({ code: "denied", httpStatus: 403, message: "GitHub checkout credential broker: denied (HTTP 403)" });
    });
  });
});
