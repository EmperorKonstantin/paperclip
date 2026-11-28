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
`PAPERCLIP_GITHUB_APP_PROJECTS`. Configure the GitHub App broker to issue repository-scoped read-only checkout
credentials for these repositories.

## Profile Settings

Send `subject`, `companyId`, and `projectId` with each action. Derive the
subject from the authenticated Untzr session on the backend.

- `status` returns opaque connection and grant references, provider, method,
  connection status, and Codex sign-in availability.
- `api-key` accepts `provider` (`openai` or `anthropic`) and a write-only
  `apiKey`. For a new managed binding, persist a unique `provisioningId` UUID
  before sending the request. Retry with the same ID and payload. Paperclip
  verifies the key with the provider, stores it encrypted, and returns only
  `connectionId`, `grantId`, and `authorizationGeneration`. A request with
  `provisioningId` creates a new binding. Existing callers can use
  `connectionId` for legacy replacements.
- `disconnect` accepts `provider` and `connectionId` and revokes the personal
  grant. Repeating the same disconnect succeeds. To rotate a managed key,
  revoke its saved connection and provision with a new UUID. Queued runs and
  retries recheck the grant before execution. A new handoff needs a new request
  ID after revocation.
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
payload after an ambiguous response. The response contains the issue ID,
identifier, and opaque authorization generation. Use a new ID for a new
request. Configure isolated Paperclip Runner agents with the matching Codex
or Claude harness for every approved stage.

Publisher launches take `taskBranch` and `startingCommit` from Untzr's
approved task branch. A later stage sends its `predecessorIssueId` with the
same branch, personal grant, and the publisher-verified current commit.
A follow-up cycle sends `followUp` as the string `"true"`, a distinct approved
branch, and the exact independently released commit. It starts with the
original implementer and retains the original user, grant, project,
workspace, and repository.

## Source publication

Untzr-bound runs use the approved read-only checkout during foreground
workspace preparation and worktree refresh. A scoped checkout refusal stops
the fetch. The trusted Untzr publisher holds the write credentials and
derives the destination from its persisted assignment.

During the source run, upload the source changes as an issue attachment of
at most 1 MiB. Save an `untzr-source` issue document with a Markdown body
containing a single JSON object with `attachmentId`, `startingCommit` (a
40-character lowercase Git SHA), and `sha256` (the lowercase digest of the
attachment bytes). Use the same signed run bearer for both the attachment
upload and the document write. Paperclip records the authenticated write
method for both records. Retain the returned `latestRevisionId` as the
publication receipt.

After that run succeeds, call `POST /api/private/untzr/source` with the usual
subject and project context plus `issueId`, `runId`, `revisionId`, and the
expected `startingCommit` from Untzr's trusted assignment. Paperclip checks the
live user, grant, agent and repository scope, the revision's authenticated
run attribution, and the attachment's matching run, agent, issue, company,
size and SHA-256. The response
contains those receipt identifiers, the repository identity, the report, and
`sourceBase64`. The publisher checks the returned identity against its approved
assignment, verifies the decoded bytes and expected starting head, and
publishes only to its approved task ref with an expected-head guard.

Record opaque connection references, task and run IDs, repository and ref,
and the output branch or PR for acceptance. Keep credentials and sign-in
codes out of that evidence.
