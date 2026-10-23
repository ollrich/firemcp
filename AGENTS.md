# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

FireMCP: a Firefox MCP server for reading the user's real browser: open tabs, live rendered pages, history, screenshots. It reads, it does not interact (no clicks, forms or page scripts beyond text extraction).

- `mcp-server`: Node MCP server. Talks to the MCP client over stdio and to the extension over a WebSocket on `127.0.0.1`/`::1`, port `EXTENSION_PORT` (default 8089). Messages are HMAC signed with `EXTENSION_SECRET`.
- `firefox-extension`: WebExtension that executes the commands.
- `common`: message types shared by both, imported as types only.

The first server process for a port and secret becomes the broker and owns the WebSocket. Further processes (other MCP clients) forward their calls to it over a local socket (`singleton-broker.ts`).

## Commands

```bash
npm install          # root, installs mcp-server and firefox-extension
npm run build        # builds both, packages the XPI into firefox-extension/web-ext-artifacts
npm test             # server tests (node:test) and extension tests (Jest)
```

Per project: `cd mcp-server && npm test` (builds first) or `cd firefox-extension && npx jest`.

`mcp-server/__tests__/workflow-tools.test.mjs` is the key test: it runs real server processes against a fake extension that behaves like the stock add-on from addons.mozilla.org.

`cd mcp-server && npm run pack-dxt` builds the Claude Desktop extension: it stages a runtime only copy, starts it once to check version and tool list against `manifest.json`, then validates and packs `firemcp-<version>.dxt`. List every tool in `manifest.json`. One version for everything: `npm run bump -- 2.0.1` in the root updates all package files, manifests and lockfiles (plain numbers only, AMO rejects suffixes).

## Releasing the add-on

Self distributed (unlisted) on addons.mozilla.org, updates through `updates.json` in this repo (`gecko.update_url`).

1. `npm run bump -- X.Y.Z`, commit.
2. `cd firefox-extension && npm run lint:amo` (must be clean), then `npm run sign` with the AMO API credentials in `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` or in the macOS Keychain (`firemcp-amo-api-key`, `firemcp-amo-api-secret`); it uploads the source archive of HEAD.
3. `npm run release:updates -- <signed .xpi>` in the root: adds the version to `updates.json` and stages `firemcp-X.Y.Z.xpi`.
4. GitHub release `vX.Y.Z` with that XPI (the workflow adds the DXT), then commit and push `updates.json`.

## Rules

- **Read only.** No tools that click, type, submit forms or run arbitrary scripts in pages.
- **Stay compatible with the stock add-on** (eyalzh's "Browser Control MCP" on addons.mozilla.org, which FireMCP grew out of). Server features should build on existing commands (`open-tab`, `get-tab-list`, `get-tab-content`, `close-tabs`, `capture-screenshot`) or degrade with a clear message. The stock add-on rejects unknown commands as "disabled in extension settings" and ignores unknown fields.
- **Extension 2.0 features** are detected with the `get-extension-info` handshake (`BrowserAPI.getExtensionInfo()`, `null` for the stock add-on), which lists the supported commands. New commands must be checked there first; new optional fields on existing commands (like `active`, `includeLinks`) need no check.
- **Protocol changes touch all three parts**: union types in `common/*-messages.ts`, the server (`browser-api.ts`, broker operation whitelist in `browser-operations.ts`, tool in `server.ts`) and the extension (`message-handler.ts`, command to tool mapping in `extension-config.ts`), with tests on both sides.
- **Keep the security model**: signed messages, per domain consent for page content, per tab consent for screenshots, domain deny list, per tool toggles and audit log in the extension.
- Strict TypeScript, exhaustive `switch` with `never`, `zod` for tool input. Match the style of the file you touch.
