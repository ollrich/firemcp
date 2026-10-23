# FireMCP

[![Release](https://img.shields.io/github/v/release/ollrich/firemcp)](https://github.com/ollrich/firemcp/releases/latest)
[![License: MIT](https://img.shields.io/github/license/ollrich/firemcp)](LICENSE)

English | [Deutsch](README.de.md)

FireMCP lets your AI assistant read your real Firefox: open tabs, live rendered pages, search within pages, history, bookmarks and screenshots. It consists of a Firefox add-on and a local MCP server, so it works with Claude Desktop, Claude Code and other MCP clients.

It reads what you already see in your browser, including pages behind a login and pages that only render with JavaScript, where a plain web fetch returns stale or empty content. It can open, close and arrange tabs, but it never clicks, types, submits forms or runs scripts of its own on pages.

## Tools

**Reading pages**

| Tool | What it does |
|------|--------------|
| `read-tab` | Read an open tab, found by URL or title fragment, by tab ID, or the active tab |
| `read-tabs` | Read several open tabs in one call |
| `open-and-read-tab` | Open a URL, wait until it has rendered and return its text |
| `open-and-read-tabs` | Open several URLs in background tabs, read them and close them again |
| `search-tab` | Find text in a tab and return snippets with offsets |
| `read-page-meta` | Meta tags, Open Graph, JSON-LD and headings of a page |
| `read-selection` | The text you have selected in a tab |
| `get-tab-web-content` | Full text and links of a tab (the original low level tool) |
| `capture-tab-screenshot` | Screenshot of the visible part of a tab |

The reading tools return compact text, by default up to 40,000 characters per call with the offset to continue from. Options: `format: "markdown"` keeps headings, lists, links and tables, `mainContentOnly` leaves out navigation and sidebars, `selector` and `excludeSelector` pick parts of a page, and `redactPersonalData` masks e-mail addresses, phone numbers, IBANs and card numbers.

**Browser data**

| Tool | What it does |
|------|--------------|
| `get-list-of-open-tabs` | Open tabs with state (active, unloaded, loading), filter and sort |
| `get-current-tab` | The tab you are looking at |
| `get-tab-metadata` | Details of one tab |
| `get-recent-browser-history` | Visited pages, newest first, filtered by words and age |
| `search-bookmarks` | Bookmarks with folder path and date added |

**Tabs**

| Tool | What it does |
|------|--------------|
| `open-browser-tab` | Open a page in a new tab |
| `close-browser-tabs` | Close tabs |
| `reorder-browser-tabs` | Change the order of tabs |
| `group-browser-tabs` | Put tabs into a named, colored tab group |
| `find-highlight-in-browser-tab` | Find and highlight text in a tab |

## What stays under your control

- **Local only.** The add-on talks to the MCP server on your computer over `127.0.0.1` and `::1`, and only accepts commands signed with a secret key that only the two of them know. FireMCP has no server of its own and collects no telemetry.
- **Consent per site.** The add-on reads a page only after you have allowed its site once. History, bookmarks and find on page are optional permissions, asked for on first use. A screenshot needs a click on the FireMCP toolbar button in that tab.
- **Deny list.** Sites on the list are never read or opened and are left out of history and bookmark results.
- **Switches and log.** Every tool can be switched off in the add-on's settings, and the last 100 actions are logged there.

Your assistant sees whatever it reads. Pages can contain text written to mislead AI assistants, so keep an eye on what your assistant does with your browser, as with any MCP server.

## Installation

You need Firefox 140 or later.

### 1. Firefox add-on

Open the [latest release](https://github.com/ollrich/firemcp/releases/latest) in Firefox and click `firemcp-<version>.xpi`. The add-on is signed by Mozilla and updates itself. Its settings page opens after the installation and shows the secret key that the MCP server needs.

### 2. MCP server

**Claude Desktop:** Download `firemcp-<version>.dxt` from the same release and open it, or drag it into the extensions page of Claude Desktop's settings. Enter the secret key under "Configure" and switch the extension on.

**Claude Code** (needs Node.js 22 or later):

```bash
git clone https://github.com/ollrich/firemcp.git
cd firemcp
npm install
npm run build
claude mcp add firemcp --scope user -e EXTENSION_SECRET=<secret> -- node "$PWD/mcp-server/dist/server.js"
```

**Other MCP clients:** Build as above, then add the server to the client's configuration:

```json
{
  "mcpServers": {
    "firemcp": {
      "command": "node",
      "args": ["/path/to/firemcp/mcp-server/dist/server.js"],
      "env": { "EXTENSION_SECRET": "<secret>" }
    }
  }
}
```

The connection to the add-on is up a few seconds after the server starts.

### Settings

| Variable | Default | Meaning |
|----------|---------|---------|
| `EXTENSION_SECRET` | (required) | Secret key from the add-on's settings page |
| `EXTENSION_PORT` | `8089` | Port for the connection to the add-on; must match the add-on's settings |
| `BROWSER_MCP_TOOLS` | `all` | `all`, `read` (only reading tools plus opening pages) or a comma separated list of tool names |
| `BROWSER_MCP_DEBUG` | off | `1` writes a detailed log to stderr |

### Several MCP clients

Several clients can use the same Firefox at once, for example Claude Desktop and a few Claude Code sessions. The first server process for a port and secret owns the connection to the add-on; further processes with the same values pass their calls on to it. A second browser or Firefox profile gets its own port and secret.

### The original add-on

FireMCP grew out of [Browser Control MCP](https://github.com/eyalzh/browser-control-mcp). The server also works with that add-on from addons.mozilla.org, with fewer features: no markdown, no selectors, no page metadata, selected text or bookmarks. Tools that need the FireMCP add-on say so.

## Examples

- *"Read the open Jira tab and list the tickets assigned to me."*
- *"Search my history for the article about night trains I read last week and summarize it."*
- *"Open the three newest results on the conference page and compare their deadlines."*

## Development

```bash
npm install
npm run build   # MCP server and add-on, the XPI lands in firefox-extension/web-ext-artifacts
npm test        # server tests (node:test) and add-on tests (Jest)
```

- `mcp-server`: the MCP server (TypeScript, Node.js)
- `firefox-extension`: the Firefox add-on (Manifest V2), texts in `_locales/en` and `_locales/de`
- `common`: message types shared by both

For a test without signing, load `firefox-extension/manifest.json` as a temporary add-on in `about:debugging`. Architecture, project rules and the release steps are in [AGENTS.md](AGENTS.md).

## Credits

FireMCP builds on the work of others:

- **[Eyal Zach (eyalzh)](https://github.com/eyalzh/browser-control-mcp)** wrote Browser Control MCP, the MCP server and Firefox add-on this project grew out of, including the tab screenshot tool ([eyalzh/browser-control-mcp#59](https://github.com/eyalzh/browser-control-mcp/pull/59)).
- **[Kostiantyn Kugot (kkugot)](https://github.com/kkugot/browser-control-mcp)** added the singleton broker that lets several MCP clients share one browser, and the `get-current-tab` and `get-tab-metadata` tools, based on pull requests by [dsdshcym](https://github.com/eyalzh/browser-control-mcp/pull/44) and [Alex Kapranoff](https://github.com/eyalzh/browser-control-mcp/pull/41).

Their full history is part of this repository. FireMCP itself is maintained by [Oliver Eichhof (ollrich)](https://github.com/ollrich).

## License

[MIT](LICENSE). Firefox is a trademark of the Mozilla Foundation; FireMCP is not affiliated with Mozilla.
