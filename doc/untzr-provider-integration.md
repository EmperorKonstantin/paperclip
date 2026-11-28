# Untzr provider integration

The private Untzr backend calls `POST /api/private/untzr/<action>` with a
dedicated bearer over TLS. Store its SHA-256 digest in
`PAPERCLIP_UNTZR_INTEGRATION_KEY_SHA256`. Provision a distinct high-entropy
bearer for this integration. Keep the bearer on the Untzr backend.

Set `PAPERCLIP_UNTZR_SCOPES` to a JSON array of operator-verified mappings.
Each entry has `subject`, `userId`, `companyId`, `projectId`, `workspaceId`,
`repositoryId` (a string), `repository` (GitHub owner and repository), `ref`
(the configured source ref), and `agentIds`. A subject maps to one Paperclip
user per company. The user must have an active membership and access to the
private project. Match the workspace, repository ID, and agents in
`PAPERCLIP_GITHUB_APP_PROJECTS`. Configure the existing GitHub App checkout
and active-run broker for these repositories.

## Profile Settings

Send `subject`, `companyId`, and `projectId` with each action. Derive the
subject from the authenticated Untzr session on the backend.

- `status` returns opaque connection and grant references, provider, method,
  connection status, and Codex sign-in availability.
- `api-key` accepts `provider` (`openai` or `anthropic`) and a write-only
  `apiKey`. Pass `connectionId` to replace an existing key for the same
  provider. Paperclip verifies the key with the provider and stores it in its
  encrypted secret store.
- `disconnect` accepts `provider` and `connectionId` and revokes the personal
  grant. Queued runs and retries recheck the grant before execution. Reconnecting
  after revocation requires a new handoff with a new request ID. Replacing
  credentials on an active grant preserves authorization for existing handoffs.
- `codex/start` accepts an optional `connectionId` for replacement. It
  returns an expiring attempt reference. Send that reference as `attempt`
  with the same context and replacement ID to `codex/status`,
  `codex/complete`, or `codex/cancel`. When status includes an OpenAI
  authorization URL and device code, present them only to the session owner.
  The user enters the code on OpenAI's site. Complete the attempt when its
  status is ready.

Enable `PAPERCLIP_UNTZR_CODEX_LOGIN=enabled` only where the operator has
verified eligibility for the native Codex sign-in flow and configured the
trusted local login environment. Use Anthropic API keys for Claude in this
integration. Hosted Claude subscription sign-in requires a separate supported
native flow.

## Dispatch

Send `provider`, `connectionId`, `grantId`, `agentId`, `requestId`, `title`,
and an optional `description` to `launch`. Reuse the same request ID and
payload after an ambiguous response. The response contains a task reference.
Use a new ID for a new request. Configure isolated Paperclip Runner agents
with the matching Codex or Claude harness for every approved stage. A task
and its follow-ups retain the original user, grant, project, workspace,
repository, and source ref.

The GitHub broker provides repository-scoped installation credentials.
GitHub repository rules must enforce permitted write branches because an
installation token authorizes repository permissions. Verify those rules
with the pilot fixtures before enabling customer dispatch. Record opaque
connection references, task and run IDs, repository and ref, and the output
branch or PR for acceptance. Keep credentials and sign-in codes out of that
evidence.
