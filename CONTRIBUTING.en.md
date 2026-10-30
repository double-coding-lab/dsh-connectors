<p align="center">
  <a href="./CONTRIBUTING.md">简体中文</a> · <strong>English</strong>
</p>

# Contributing providers

Built-in providers in `dsh-connectors` are data only: adding one means adding a directory, with no changes to the core code. The contract lives in [`schema/provider.schema.json`](schema/provider.schema.json).

## What we accept

- Remote MCP services run by the vendor. A regular provider must use an `https://` endpoint.
- Services that need a user-supplied MCP URL use an `instance` block; the address is provided at runtime (https, http, or a private network). `auth` can be `none`, `bearer`, `header`, or `oauth2`.
- Static catalog copy, examples, and an optional icon.
- A real credential test: the provider connects and registers tools.

## What we don't accept

- Providers that carry executable code, build scripts, or runtime injection.
- Tokens, client secrets, or fixed private-network addresses in `provider.json`.
- Plain `http://` endpoints outside `instance`, proxy services, or unofficial relay endpoints. Use the in-app **Custom connector** for those.
- Telemetry, data reporting, or remote configuration.

## Directory layout

```text
providers/
  acme/
    provider.json   # required
    icon.svg        # optional; icon.png and icon.webp also work
```

- The `id` in `provider.json` must match the directory name.
- `serverName` defaults to `id` and must be globally unique. It becomes the tool prefix `mcp__<serverName>__`.
- Icons should be 24×24 SVG. Without one, the client falls back to a colored block with the first letter.

## Quick start

```bash
npm run provider:new -- acme --auth bearer --name "Acme"
# Edit providers/acme/provider.json and replace the TODOs and example URL.
# Optional: add providers/acme/icon.svg
npm run check
```

`npm run check` runs the type check, build, provider validation, and endpoint/contract tests (duplicate ids and serverNames, missing fields, URLs, ordering).

## Generic endpoint providers (instance)

If a service needs the user to enter a complete MCP URL (self-hosted GitLab, Amap), add an `instance` block and leave `server.url` unset:

```json
{
  "instance": {
    "label": "Service URL",
    "placeholder": "https://example.com/mcp",
    "hint": "Enter the complete MCP endpoint. Do not include credentials or a fragment.",
    "help": {
      "url": "https://example.com/docs/mcp",
      "label": "Open setup guide",
      "hint": "Create the service in the console, then copy its URL."
    }
  },
  "server": {
    "serverName": "example",
    "transport": "streamable-http"
  },
  "auth": { "type": "none" }
}
```

Rules:

- `instance.label` is required; `placeholder`, `hint`, and `help` are optional. `help` renders an official link in the address dialog (`{ url, label, hint? }`; the URL must be https).
- Do not set `server.url` with an `instance`. The user supplies the full address.
- At runtime the address accepts http/https and private networks, and allows a query string (for endpoints such as `?key=...`). It rejects credentials and fragments. The UI shows a plain-text warning for http.
- The address is saved exactly as entered; no path is appended. The provider's `placeholder` and `hint` should show a complete endpoint example.
- All four auth types work: `none` connects after saving; `bearer` and `header` open a separate token dialog; `oauth2` requires DCR on the instance and starts authorization after saving.
- For an `instance` provider, the plus button first writes an install record without a URL, then opens the address dialog. The detail view only shows a hint and a **Configure** button.
- Once configured, `instanceReady=true`. **Change address** disconnects the old connection, clears credentials, updates the URL, and requires configuration or authorization again. Closing the dialog before configuring keeps the install, so the user can come back.

### Preset endpoints (instance.presets)

If the addresses are a fixed set of endpoints (QCC splits ten data domains across MCP services), use `presets` to turn the dialog into a dropdown:

```json
{
  "instance": {
    "label": "Data domain",
    "noun": "data domain",
    "presets": [
      { "label": "Company records", "url": "https://example.com/mcp/company/stream" },
      { "label": "Risk records", "url": "https://example.com/mcp/risk/stream" }
    ]
  }
}
```

- Every preset requires `label` and `url`; the URL must be https and the array cannot be empty.
- With `presets`, the user picks from the list; manual entry and the http warning are removed.
- `noun` only changes the wording: card and detail actions say "Change data domain" instead of "Change address", and the hint becomes "Select a data domain". Without it, the UI says "address".
- Each preset is a separate MCP endpoint. Switching disconnects the current connection, clears credentials, and requires a new connection. Make this clear in the UI.

## Transport

- `server.transport` supports `streamable-http` and legacy `sse`. An `sse` URL must also be https. The plugin's built-in stdio bridge adapts it for `@deepseek-ai/dsh-mcp-client`; providers need no extra code.

## Auth types

| type | Use case | Key fields |
| --- | --- | --- |
| `none` | Public MCP with no credentials | — |
| `bearer` | `Authorization: Bearer <token>` | `label`, optional `help` |
| `header` | Custom header such as `X-API-Key` | `header`, optional `prefix`, `label`, `help` |
| `oauth2` | OAuth 2.0 Authorization Code + PKCE | `flow: "pkce"`, `registration`, optional `scopes` / `clientName` |

OAuth `registration`:

- `"dcr"`: the server supports dynamic client registration (preferred).
- `{ "clientId": "..." }`: the vendor provides a public client ID and no client secret is required.
- `"user"`: the user enters an AppKey / SecretKey in the panel. The provider must declare `endpoints`, and may set `authorizeParams`, `tokenMethod`, and `pkce`. Use this for services without DCR where the user brings their own app.

When the server exposes standard OAuth metadata, the host handles discovery and the provider only declares `registration` and `scopes`. In `user` mode the provider's `endpoints` are used directly.

1. Send an unauthorized `initialize` to the MCP endpoint and read `resource_metadata` from the 401 `WWW-Authenticate` header (RFC 9728, preferred).
2. Without that header, try `{origin}/.well-known/oauth-protected-resource{path}` and then `{resource}/.well-known/oauth-protected-resource`.
3. Take `authorization_servers[0]` as the issuer and read `{issuer}/.well-known/oauth-authorization-server`.
4. Use the provider's `scopes` first; only fall back to the first scope in the resource metadata.
5. Authorization, token exchange, and refresh all send the resource metadata's `resource` (RFC 8707). Tianyancha requires it to equal the MCP endpoint; other services can ignore it.

Device code and mTLS are not supported. Custom connectors do not have a multi-field credential form. Use `bearer` or `header` for API-key-only services. When a service supports both OAuth and API keys, the built-in card uses OAuth and the key path is left to custom connectors' `headers`.

## Credential help links

Token-based providers should include `help`:

```json
"help": {
  "url": "https://vendor.example/tokens",
  "label": "Create an API key",
  "hint": "Create it under Settings → API. The token stays on this machine."
}
```

The authorization form shows this link and hint. Link to the vendor's official credential page.

## Copy and examples

- `summary`: one line on the card, at most one line of text.
- `description`: one or two sentences in the detail dialog.
- `examples`: 1–6 prompts the user can send to the agent. Do not write operational instructions such as "click here".
- `category`: one of the fixed identifiers `开发工具 / 项目管理 / 数据库 / 知识检索 / 办公协作 / 安全运维 / 数据分析 / 其他` (developer tools, project management, databases, search & knowledge, productivity, security & ops, analytics, other).

## Localized copy

Top-level `summary`, `description`, and `examples` are the Chinese defaults. Add `translations.en` to override `name`, `vendor`, `summary`, `description`, or `examples`; missing fields fall back to the top-level values. `category` stays a fixed Chinese enum, and the client localizes its label.

## Verification checklist

- [ ] `npm run check` passes
- [ ] `provider.json` exists and its `id` matches the directory name
- [ ] The endpoint is the vendor's official `https://` MCP endpoint, confirmed in the browser or docs
- [ ] Installed and connected with a real credential; the tool count is recorded
- [ ] Credentials stay on the host; `provider.json` contains no secrets
- [ ] Example prompts work and contain no internal project names or personal data
- [ ] The icon (if any) is official brand material with no external scripts or references
- [ ] The PR description links the vendor's MCP docs and the tested tool count

## Release and compatibility

- `schemaVersion` is currently `1`. New capabilities are added as backward-compatible optional fields.
- Removing or renaming a provider id is a breaking change and needs its own discussion.
- Validation and catalog loading live in `src/host/providers.ts`; the contract is `schema/provider.schema.json`.

## Release

1. Bump `version` in `package.json`, refresh `assets/readme/badges/npm.svg` (download the npm badge again), and commit to `main`.
2. Tag the same version (`vX.Y.Z`) and push the tag to GitHub.
3. Create a GitHub Release for that tag. `publish-npm.yml` runs `npm run check` and publishes to npm with Trusted Publishing + provenance.
4. The first release needs a manual `npm login --registry=https://registry.npmjs.org` and `npm publish --access public` to create the package. Then configure Trusted Publishing in the npm package settings: organization `double-coding-lab`, repository `dsh-connectors`, workflow `publish-npm.yml`.

Pushing alone does not publish; the Release must be published.
