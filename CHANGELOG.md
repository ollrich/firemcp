# Changelog

Versions follow [Semantic Versioning](https://semver.org/); the add-on, the MCP server and the Claude Desktop extension share one version number.

## 2.2.0 (2026-10-23)

### Added

- New logo: a flame between angle brackets, for the add-on and the Claude Desktop extension.

### Fixed

- Markdown keeps headings, paragraphs and lists inside custom elements, for example GitHub's `<turbo-frame>`. Before, such pages came as one line (add-on).
- The header of a page read ends with a line break, so clients that join the text blocks of a reply keep it apart from the page text.

### Changed

- History and bookmark URLs over 300 characters come shortened, for example signed download links.
- The installation guide link on the settings page opens the README in the browser's language (add-on).

## 2.1.0 (2026-10-23)

### Added

- The add-on speaks English and German, following the browser language: name, description, settings page, consent dialogs and tool names.
- The MCP server waits for your answer when history, bookmarks or find on page need consent, then tries once more (`consentWaitMs`).

### Changed

- Browser history is an optional permission, asked for on first use.
- Bookmarks ask for the optional bookmark data sharing together with the permission (Firefox 140 and later).
- The add-on description no longer says "read only": FireMCP can open, close and arrange tabs, but never clicks or types on pages. The settings page groups reading tools and tab tools.
- Sites on the deny list are left out of history results too.

## 2.0.1 (2026-10-23)

### Fixed

- After you allow a new site, Firefox returns to the tab you were on instead of a tab FireMCP had just opened in the background.
- `mainContentOnly` also leaves out navigation, sidebars and search areas inside the main content, such as Wikipedia's tool menus.

## 2.0.0 (2026-10-23)

First release as FireMCP, an own project with its own Firefox add-on (signed by Mozilla, self distributed with automatic updates) and Claude Desktop extension. Compared with Browser Control MCP 1.5.2:

### Added

- Reading in one step: `read-tab`, `read-tabs`, `open-and-read-tab` and `open-and-read-tabs`, which wait until script rendered pages are complete and read unloaded tabs through a temporary copy.
- `search-tab` finds phrases across a whole page and returns snippets with offsets.
- Markdown output, CSS selectors and main content only (add-on).
- `read-page-meta` (meta tags, Open Graph, JSON-LD, headings), `read-selection` and `search-bookmarks` (add-on).
- `capture-tab-screenshot`, after you authorize the tab with the toolbar button.
- Compact replies of up to 40,000 characters with an offset to continue from, and optional masking of personal data.
- Several MCP clients share one browser connection through a local broker.
- Tool annotations and tool profiles (`BROWSER_MCP_TOOLS`).

### Changed

- Pages opened only for reading stay in the background (`background`, add-on).
- The action log of the add-on counts repeated calls instead of listing each one.

Earlier versions are part of [Browser Control MCP](https://github.com/eyalzh/browser-control-mcp) by eyalzh and the [fork by kkugot](https://github.com/kkugot/browser-control-mcp) with the singleton broker. Their history is in this repository's git log.
