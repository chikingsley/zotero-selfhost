# Zotero API key compatibility

## Current implementation

- `GET /keys/current` and `GET /users/:userID/keys/current`.
- `GET /keys/:apiKey` and deprecated `GET /users/:userID/keys/:apiKey`.
- Root-only `GET /users/:userID/keys`.
- Root-only `POST /users/:userID/keys`.
- Local credential-style `POST /keys` private API.
- Local credential/root/current-key `PUT /keys/:apiKey`.
- Root-only `PUT /users/:userID/keys/:apiKey`.
- `DELETE /keys/current`, `DELETE /users/:userID/keys/current`, `DELETE /keys/:apiKey`, and deprecated `DELETE /users/:userID/keys/:apiKey`.
- Created keys are stored in D1 `api_keys` or memory mode and immediately work with existing auth checks.
- Authenticated user/group requests update `lastUsed` metadata for root key listings.
- `POST /keys/sessions` creates pending browser login sessions.
- `GET /keys/sessions/:sessionToken` polls pending, cancelled, or completed status.
- `DELETE /keys/sessions/:sessionToken` cancels pending sessions.
- Root-only `GET /keys/sessions/:sessionToken/info` exposes pending session user/access context.
- Root-only `POST /keys/sessions/complete` completes a session and creates a local API key.
- Session-created API keys are named from the detected Zotero desktop platform in the `User-Agent`.

## Known gaps

- The official key and login-session remote-test slices have not been run against this Worker.
- Username, display name, email, and password handling are local compatibility shims, not a full Zotero account database.
- Recent IP tracking is represented structurally but does not persist IP history.
- Login sessions are local D1/memory sessions; they do not include a rendered hosted login page yet.

## Reference tests to run

- `references/dataserver/tests/remote/tests/3/keys.test.js`
- `references/dataserver/tests/remote/tests/3/loginSessions.test.js`
