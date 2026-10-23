import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BrowserAPI, type ContentOptions } from "./browser-api";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import type { BrowserTab, PageMeta, TabContentExtensionMessage } from "@browser-control-mcp/common";
import fs from "fs";
import path from "path";
import {
  compactMarkdown,
  compactText,
  filterTabs,
  findSnippets,
  formatTabLine,
  isConsentTabFor,
  isFeatureConsentTabFor,
  markPhrases,
  matchTabs,
  normalizeOpenUrl,
  pickActiveTab,
  redactPersonalData,
  slimContent,
  tabFlags,
} from "./content-utils";

dayjs.extend(relativeTime);

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const mcpServer = new McpServer({
  name: "FireMCP",
  version: readPackageVersion(),
});

// MCP tool annotations, so clients can tell reading tools from ones that change
// the browser. openWorldHint marks tools that load or read web content.
const READS_BROWSER = { readOnlyHint: true, openWorldHint: false };
const READS_WEB = { readOnlyHint: true, openWorldHint: true };
const OPENS_PAGES = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const CHANGES_TABS = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

// How long a tool waits for the user to answer the add-on's consent dialog.
const DEFAULT_CONSENT_WAIT_MS = 30_000;
const consentWaitParam = (firstUse: string) =>
  z
    .number()
    .int()
    .min(0)
    .max(120_000)
    .default(DEFAULT_CONSENT_WAIT_MS)
    .describe(`How long to wait for the user to grant access when ${firstUse} for the first time (0 = fail right away)`);

// BROWSER_MCP_TOOLS picks the offered tools: "all" (default), "read" (tools that
// only read, plus opening pages) or a comma separated list of tool names.
const toolProfile = (process.env.BROWSER_MCP_TOOLS ?? "").trim() || "all";
const knownToolNames: string[] = [];

function isToolEnabled(name: string, annotations: ToolAnnotations): boolean {
  if (toolProfile === "all") return true;
  if (toolProfile === "read") {
    return annotations.readOnlyHint === true || (annotations.openWorldHint === true && annotations.destructiveHint === false);
  }
  return toolProfile.split(",").map((entry) => entry.trim()).includes(name);
}

function registerTool<Args extends ZodRawShapeCompat>(
  name: string,
  description: string,
  paramsSchema: Args,
  annotations: ToolAnnotations,
  cb: ToolCallback<Args>
): void {
  knownToolNames.push(name);
  if (isToolEnabled(name, annotations)) {
    mcpServer.tool(name, description, paramsSchema, annotations, cb);
  }
}

registerTool(
  "open-browser-tab",
  "Open a new tab in the user's browser (useful when the user asks to open a website)",
  { url: z.string() },
  OPENS_PAGES,
  async ({ url: input }) => {
    const { url, note } = normalizeOpenUrl(input);
    const openedTabId = await browserApi.openTab(url);
    if (openedTabId !== undefined) {
      return {
        content: [
          {
            type: "text",
            text: `${url} opened in tab id ${openedTabId}${note ? `. ${note}` : ""}`,
          },
        ],
      };
    } else {
      return {
        content: [{ type: "text", text: "Failed to open tab" }],
        isError: true,
      };
    }
  }
);

registerTool(
  "close-browser-tabs",
  "Close tabs in the user's browser by tab IDs",
  { tabIds: z.array(z.number()) },
  { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  async ({ tabIds }) => {
    await browserApi.closeTabs(tabIds);
    return {
      content: [{ type: "text", text: "Closed tabs" }],
    };
  }
);

registerTool(
  "get-list-of-open-tabs",
  `Get the list of open tabs in the user's browser, one line per tab with state flags
   (active, unloaded, loading). Filter with match; page with offset and limit.`,
  {
    match: z
      .string()
      .optional()
      .describe("Only tabs whose URL or title contains all these words, e.g. 'github' or 'spiegel politik'"),
    sort: z
      .enum(["position", "recent"])
      .default("position")
      .describe("position = browser order, recent = most recently used first"),
    offset: z.number().int().min(0).default(0).describe("Starting index for pagination (0-based, must be >= 0)"),
    limit: z.number().default(100).describe("Maximum number of tabs to return (default: 100, max: 500)"),
  },
  READS_BROWSER,
  async ({ match, sort, offset, limit }) => {
    const effectiveLimit = Math.min(Math.max(1, limit), 500);

    let tabs = await browserApi.getTabList();
    if (match) tabs = filterTabs(tabs, match);
    if (sort === "recent") tabs = [...tabs].sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    const total = tabs.length;
    const page = tabs.slice(offset, offset + effectiveLimit);
    const hasMore = offset + effectiveLimit < total;

    const summary =
      total === 0
        ? `No open tabs${match ? ` match "${match}"` : ""}.`
        : page.length === 0
          ? `No tabs at offset=${offset}; there are ${total}${match ? ` matching "${match}"` : ""}.`
          : `Showing tabs ${offset + 1}-${offset + page.length} of ${total}${match ? ` matching "${match}"` : ""}` +
          (hasMore ? ` (use offset=${offset + effectiveLimit} to see more)` : "");
    const lines = page.map((tab) => {
      const lastAccessed = tab.lastAccessed ? dayjs(tab.lastAccessed).fromNow() : "unknown";
      const flags = tabFlags(tab);
      return `tab id=${tab.id}, url=${tab.url}, title=${tab.title}, last accessed=${lastAccessed}${flags.length ? `, ${flags.join(", ")}` : ""}`;
    });

    return {
      content: [{ type: "text", text: [summary, ...lines].join("\n") }],
    };
  }
);

registerTool(
  "get-current-tab",
  "Get information about the currently active tab in the browser",
  {},
  READS_BROWSER,
  async () => {
    const currentTab = await browserApi.getCurrentTab();
    return {
      content: [
        {
          type: "text",
          text: `Current tab: id=${currentTab.id}, url=${currentTab.url}, title=${currentTab.title}`,
        },
      ],
    };
  }
);

registerTool(
  "get-tab-metadata",
  "Get comprehensive metadata about a specific tab, including state, position, window, audio, dimensions, favicon, and last access properties when available.",
  { tabId: z.number() },
  READS_BROWSER,
  async ({ tabId }) => {
    const metadata = await browserApi.getTabMetadata(tabId);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(metadata, null, 2),
        },
      ],
    };
  }
);

registerTool(
  "get-recent-browser-history",
  `Get recently visited pages from the browser history, newest first, one line per page
   (to get all, don't use searchQuery). The browser returns at most 200 pages per query.
   The FireMCP add-on asks the user for the history permission on first use.`,
  {
    searchQuery: z.string().optional().describe("Words that must appear in the URL or title"),
    sinceHours: z.number().min(0).optional().describe("Only pages visited within this many hours"),
    limit: z.number().int().min(1).max(200).default(50),
    consentWaitMs: consentWaitParam("the history is read"),
  },
  READS_BROWSER,
  async ({ searchQuery, sinceHours, limit, consentWaitMs }) => {
    let items = await withFeatureConsent("history", consentWaitMs, () => browserApi.getBrowserRecentHistory(searchQuery));
    if (sinceHours !== undefined) {
      const since = Date.now() - sinceHours * 3_600_000;
      items = items.filter((item) => (item.lastVisitTime ?? 0) >= since);
    }
    items = [...items].sort((a, b) => (b.lastVisitTime ?? 0) - (a.lastVisitTime ?? 0));

    if (items.length === 0) {
      // Point the model at the broader query instead of a dead end.
      const hint = searchQuery || sinceHours !== undefined ? " Try without searchQuery or sinceHours." : "";
      return { content: [{ type: "text", text: `No history found.${hint}` }] };
    }

    const shown = items.slice(0, limit);
    const lines = shown.map((item) => {
      const lastVisited = item.lastVisitTime ? dayjs(item.lastVisitTime).fromNow() : "unknown";
      const title = item.title && item.title !== "null" ? `, title="${item.title}"` : "";
      return `url=${item.url}${title}, last visited=${lastVisited}`;
    });
    const summary = `${shown.length} of ${items.length} pages${items.length > shown.length ? ` (raise limit to see more)` : ""}`;
    return { content: [{ type: "text", text: [summary, ...lines].join("\n") }] };
  }
);

registerTool(
  "get-tab-web-content",
  `
    Get the full text content of the webpage and the list of links in the webpage, by tab ID. 
    Use "offset" only for larger documents when the first call was truncated and if you require more content in order to assist the user.
  `,
  {
    tabId: z.number(),
    offset: z.number().int().min(0).default(0),
    includeLinks: z.boolean().default(true).describe("Set false to skip the link list"),
  },
  READS_WEB,
  async ({ tabId, offset, includeLinks }) => {
    const content = await browserApi.getTabContent(tabId, offset, { includeLinks });
    let links: { type: "text"; text: string }[] = [];
    if (offset === 0 && includeLinks) {
      // Only include the links if offset is 0 (default value). Otherwise, we can
      // assume this is not the first call. Adding the links again would be redundant.
      links = content.links.map((link: { text: string; url: string }) => {
        return {
          type: "text",

          text: `Link text: ${link.text}, Link URL: ${link.url}`,
        };
      });
    }

    let text = content.fullText;
    let hint: { type: "text"; text: string }[] = [];
    if (content.isTruncated || offset > 0) {
      // If the content is truncated, add a "tip" suggesting
      // that another tool, search in page, can be used to
      // discover additional data.
      const rangeString = `${offset}-${offset + text.length}`;
      hint = [
        {
          type: "text",
          text:
            `The following text content is truncated due to size (includes character range ${rangeString} out of ${content.totalLength}). ` +
            "If you want to read characters beyond this range, please use the 'get-tab-web-content' tool with an offset. ",
        },
      ];
    }

    return {
      content: [...hint, { type: "text", text }, ...links],
    };
  }
);

registerTool(
  "reorder-browser-tabs",
  "Change the order of open browser tabs",
  { tabOrder: z.array(z.number()) },
  { ...CHANGES_TABS, idempotentHint: true },
  async ({ tabOrder }) => {
    const newOrder = await browserApi.reorderTabs(tabOrder);
    return {
      content: [
        { type: "text", text: `Tabs reordered: ${newOrder.join(", ")}` },
      ],
    };
  }
);

registerTool(
  "find-highlight-in-browser-tab",
  `Find and highlight text in a browser tab (use a query phrase that exists in the web content).
   The first use asks the user for the find permission.`,
  { tabId: z.number(), queryPhrase: z.string(), consentWaitMs: consentWaitParam("text is highlighted") },
  CHANGES_TABS,
  async ({ tabId, queryPhrase, consentWaitMs }) => {
    const noOfResults = await withFeatureConsent("find", consentWaitMs, () => browserApi.findHighlight(tabId, queryPhrase));
    return {
      content: [
        {
          type: "text",
          text: `Number of results found and highlighted in the tab: ${noOfResults}`,
        },
      ],
    };
  }
);

registerTool(
  "group-browser-tabs",
  "Organize opened browser tabs in a new tab group",
  {
    tabIds: z.array(z.number()),
    isCollapsed: z.boolean().default(false),
    groupColor: z
      .enum([
        "grey",
        "blue",
        "red",
        "yellow",
        "green",
        "pink",
        "purple",
        "cyan",
        "orange",
      ])
      .default("grey"),
    groupTitle: z.string().default("New Group"),
  },
  CHANGES_TABS,
  async ({ tabIds, isCollapsed, groupColor, groupTitle }) => {
    const groupId = await browserApi.groupTabs(
      tabIds,
      isCollapsed,
      groupColor,
      groupTitle
    );
    return {
      content: [
        {
          type: "text",
          text: `Created tab group "${groupTitle}" with ${tabIds.length} tabs (group ID: ${groupId})`,
        },
      ],
    };
  }
);

registerTool(
  "capture-tab-screenshot",
  `
    Capture a screenshot of the visible area of a browser tab, by tab ID (default: the active tab).
    The user must authorize each tab by clicking the extension's toolbar button while that tab is open.
    If the tab is not authorized, this tool returns an error explaining what to ask the user to do; relay that
    request to the user and retry afterwards. Authorization ends when the tab navigates or closes.
    Capturing brings the tab to the foreground momentarily.
  `,
  {
    tabId: z.number().optional(),
    format: z
      .enum(["jpeg", "png"])
      .default("jpeg")
      .describe("Use png only when exact pixel fidelity matters, as it is much larger"),
    quality: z
      .number()
      .int()
      .min(10)
      .max(100)
      .default(70)
      .describe("JPEG quality, ignored for png"),
    scale: z
      .number()
      .min(0.1)
      .max(2)
      .default(1)
      .describe("Image scale relative to CSS pixels, lower values produce smaller images"),
  },
  READS_WEB,
  async ({ tabId, format, quality, scale }) => {
    const targetId = tabId ?? pickActiveTab(await browserApi.getTabList(), true)?.id;
    if (targetId === undefined) {
      return { content: [{ type: "text", text: "No open web page tab to capture." }], isError: true };
    }
    const screenshot = await browserApi.captureScreenshot(targetId, format, quality, scale);
    return {
      content: [
        {
          type: "image",
          data: screenshot.imageData,
          mimeType: screenshot.mimeType,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Reading tools. They build on the commands every add-on version knows (open-tab,
// get-tab-list, get-tab-content, close-tabs), so they also work with the original
// Browser Control MCP add-on; options only the FireMCP add-on honours are noted
// in the reply when they had no effect.
// ---------------------------------------------------------------------------

type TextContent = { type: "text"; text: string };

const DEFAULT_SETTLE_MS = 1000;
const DEFAULT_MAX_SETTLE_MS = 8000;
const DEFAULT_LOAD_TIMEOUT_MS = 20_000;
// Below this many characters a page probably is an unrendered script shell.
const MIN_RENDERED_CHARS = 300;
const CONSENT_POLL_MS = 1500;
// Never seeing the consent tab means the extension works differently; stop waiting.
const CONSENT_TAB_GRACE_MS = 4000;
const CONSENT_ERROR = /not yet granted permission to access the domain/i;
const FEATURE_CONSENT_ERROR = /not yet granted permission for the following operations/i;
// The extension returns one chunk of about 50k raw characters per call; with a
// larger maxChars further chunks are fetched, up to this many.
const MAX_CHUNKS_PER_READ = 10;
// MCP clients offload or cut tool replies from about 50 KB on (Claude Code
// saves them to a file), so a reply stays below that unless asked otherwise.
const DEFAULT_MAX_CHARS = 40_000;

const slimParams = {
  includeLinks: z
    .boolean()
    .default(false)
    .describe("Include the page's links (deduplicated). Off by default to save context."),
  maxLinks: z.number().int().min(0).max(500).default(40),
  maxChars: z
    .number()
    .int()
    .min(1)
    .max(MAX_CHUNKS_PER_READ * 50_000)
    .default(DEFAULT_MAX_CHARS)
    .describe(
      `Cap on returned characters (default ${DEFAULT_MAX_CHARS}; MCP clients offload or cut much larger replies). The reply names the offset to continue from. Values above one extension chunk (about 50k raw characters) fetch the following chunks.`
    ),
  consentWaitMs: consentWaitParam("a domain is read"),
  format: z
    .enum(["text", "markdown"])
    .default("text")
    .describe("markdown keeps headings, lists, links, tables and code blocks (FireMCP add-on; the original add-on sends text)"),
  mainContentOnly: z
    .boolean()
    .default(false)
    .describe("Only the page's main content, without navigation, sidebars and search boxes (FireMCP add-on)"),
  selector: z
    .string()
    .optional()
    .describe("CSS selector: read only this element, e.g. '#comments' or 'article' (FireMCP add-on)"),
  excludeSelector: z
    .string()
    .optional()
    .describe("CSS selector of elements to leave out, e.g. 'aside, .ads' (FireMCP add-on)"),
  redactPersonalData: z
    .boolean()
    .default(false)
    .describe("Mask e-mail addresses, phone numbers, IBANs and card numbers in the returned text"),
};

interface SlimReadOptions {
  includeLinks: boolean;
  maxLinks: number;
  maxChars: number;
  consentWaitMs: number;
  format: "text" | "markdown";
  mainContentOnly: boolean;
  redactPersonalData: boolean;
  selector?: string;
  excludeSelector?: string;
}

// Only send the optional fields that differ from the plain text default.
function contentOptions(opts: SlimReadOptions): ContentOptions {
  return {
    includeLinks: opts.includeLinks,
    ...(opts.format === "markdown" ? { format: "markdown" as const } : {}),
    ...(opts.mainContentOnly ? { mainContentOnly: true } : {}),
    ...(opts.selector ? { selector: opts.selector } : {}),
    ...(opts.excludeSelector ? { excludeSelector: opts.excludeSelector } : {}),
  };
}

interface OpenReadOptions extends SlimReadOptions {
  offset: number;
  settleMs: number;
  maxSettleMs: number;
  timeoutMs: number;
  closeAfter: boolean;
  waitForText?: string;
  // Open without switching to the tab (FireMCP add-on; the original add-on ignores it).
  background?: boolean;
}

// The page still waits for the user's domain consent; the tab is worth keeping.
class ConsentPendingError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForTabComplete(
  tabId: number,
  timeoutMs: number
): Promise<{ loaded: boolean; tab: BrowserTab }> {
  const deadline = Date.now() + timeoutMs;
  let delay = 250;
  for (;;) {
    const tab = (await browserApi.getTabList()).find((t) => t.id === tabId);
    if (!tab) {
      throw new Error(`Tab ${tabId} disappeared while loading`);
    }
    // Right after tabs.create Firefox can report about:blank as complete before the
    // navigation starts. Older extension builds may omit status; treat that as ready.
    if (tab.url !== "about:blank" && (tab.status === undefined || tab.status === "complete")) {
      return { loaded: true, tab };
    }
    if (Date.now() + delay > deadline) {
      return { loaded: false, tab };
    }
    await sleep(delay);
    // Back off: every poll is a full tab list and an audit log entry in the extension.
    delay = Math.min(Math.round(delay * 1.5), 1000);
  }
}

// The extension answers the first read of a domain, or the first use of an
// optional permission, with an error and opens its consent page in a new tab,
// which closes itself once the user grants access.
async function waitForConsent(isConsentTab: (tab: BrowserTab) => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  let seenConsentTab = false;
  // Look right away: the consent tab exists before the error arrives, and a quick
  // click could close it before a delayed first look.
  for (;;) {
    const pending = (await browserApi.getTabList()).some(isConsentTab);
    const elapsed = Date.now() - start;
    if (pending) {
      seenConsentTab = true;
    } else if (seenConsentTab) {
      return true;
    } else if (elapsed > CONSENT_TAB_GRACE_MS) {
      return false;
    }
    if (elapsed + CONSENT_POLL_MS > timeoutMs) {
      return false;
    }
    await sleep(CONSENT_POLL_MS);
  }
}

async function fetchTabContent(
  tab: BrowserTab,
  offset: number,
  consentWaitMs: number,
  options: ContentOptions = {}
): Promise<TabContentExtensionMessage> {
  return withDomainConsent(tab, consentWaitMs, () =>
    browserApi.getTabContent(tab.id as number, offset, options)
  );
}

// Run a call; when the extension answers with consentError and asks the user,
// wait for the consent tab (see waitForConsent) and run the call once more.
async function withConsent<T>(
  consentError: RegExp,
  isConsentTab: (tab: BrowserTab) => boolean,
  consentWaitMs: number,
  pendingConsent: (error: unknown) => unknown,
  call: () => Promise<T>
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!consentError.test(errorText(error))) {
      throw error;
    }
    // Every failed call opens another consent tab, so only retry after the
    // consent tab has closed.
    if (consentWaitMs <= 0 || !(await waitForConsent(isConsentTab, consentWaitMs))) {
      throw pendingConsent(error);
    }
    try {
      return await call();
    } catch (retryError) {
      throw consentError.test(errorText(retryError)) ? pendingConsent(retryError) : retryError;
    }
  }
}

// A page read that may need the user's consent to the tab's domain.
async function withDomainConsent<T>(
  tab: BrowserTab,
  consentWaitMs: number,
  read: () => Promise<T>
): Promise<T> {
  const tabId = tab.id as number;
  return withConsent(
    CONSENT_ERROR,
    (t) => isConsentTabFor(t, tab.url),
    consentWaitMs,
    (error) =>
      new ConsentPendingError(
        `${errorText(error)} Once the user has granted access, call read-tab with tabId=${tabId}.`
      ),
    read
  );
}

// A call that may need an optional permission of the FireMCP add-on (history,
// bookmarks, find). The extension's error already says to try again.
async function withFeatureConsent<T>(permission: string, consentWaitMs: number, call: () => Promise<T>): Promise<T> {
  return withConsent(FEATURE_CONSENT_ERROR, (t) => isFeatureConsentTabFor(t, permission), consentWaitMs, (error) => error, call);
}

function lengthsSettled(previous: number, current: number): boolean {
  return Math.abs(previous - current) <= Math.floor(Math.max(previous, current) * 0.005);
}

function normalizeForSearch(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

// Script heavy pages (X, Bluesky, SPAs) keep rendering after "complete". Read
// until the text length stops changing (two matching reads, three while the page
// still looks like an empty shell), or with waitForText until that text shows
// up, at most until maxSettleMs runs out.
async function readWhenStable(
  tab: BrowserTab,
  offset: number,
  maxSettleMs: number,
  consentWaitMs: number,
  waitForText?: string,
  options: ContentOptions = {}
): Promise<{ content: TabContentExtensionMessage; textFound?: boolean }> {
  const needle = waitForText ? normalizeForSearch(waitForText) : "";
  const containsNeedle = (c: TabContentExtensionMessage) =>
    normalizeForSearch(c.fullText).includes(needle);

  let content = await fetchTabContent(tab, offset, consentWaitMs, options);
  let length = compactText(content.fullText).length;
  let matchingReads = 1;
  let delay = 600;
  const deadline = Date.now() + maxSettleMs;
  const settled = () =>
    needle
      ? containsNeedle(content)
      : matchingReads >= (length >= MIN_RENDERED_CHARS ? 2 : 3);
  while (!settled() && Date.now() + delay <= deadline) {
    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.5), needle ? 1000 : 2000);
    const next = await fetchTabContent(tab, offset, 0, options);
    const nextLength = compactText(next.fullText).length;
    matchingReads = lengthsSettled(length, nextLength) ? matchingReads + 1 : 1;
    content = next;
    length = nextLength;
  }
  return { content, textFound: needle ? containsNeedle(content) : undefined };
}

// The extension returns one chunk per call. With maxChars beyond that, append
// the following chunks until the cap is reached or the page ends.
async function extendToMaxChars(
  tab: BrowserTab,
  offset: number,
  content: TabContentExtensionMessage,
  maxChars: number,
  options: ContentOptions = {}
): Promise<TabContentExtensionMessage> {
  let chunks = 1;
  while (
    maxChars > 0 &&
    content.isTruncated &&
    chunks < MAX_CHUNKS_PER_READ &&
    compactText(content.fullText).length < maxChars
  ) {
    // Links come with the first chunk only.
    const next = await fetchTabContent(tab, offset + content.fullText.length, 0, { ...options, includeLinks: false });
    if (!next.fullText) break;
    content = {
      ...content,
      fullText: content.fullText + next.fullText,
      isTruncated: next.isTruncated,
      totalLength: next.totalLength,
    };
    chunks++;
  }
  return content;
}

function formatTabContent(
  tab: BrowserTab,
  offset: number,
  content: TabContentExtensionMessage,
  opts: SlimReadOptions,
  tabWillClose = false
): TextContent[] {
  const tabId = tab.id as number;
  const markdown = content.format === "markdown";
  const slim = slimContent(content.fullText, content.links, {
    ...opts,
    pageUrl: tab.url,
    compact: markdown ? compactMarkdown : compactText,
  });
  // Offsets count raw page characters, so continue after the raw text shown.
  const end = offset + slim.rawConsumed;

  // Some clients join the text blocks of a reply without a separator.
  const header: TextContent = {
    type: "text",
    text: `${formatTabLine(tab)}, characters ${offset}-${end} of ${content.totalLength}\n`,
  };
  const notes: string[] = [];
  if (slim.cutByMaxChars || content.isTruncated) {
    const reason = slim.cutByMaxChars
      ? `Output was cut at maxChars=${opts.maxChars}.`
      : "Page text is truncated.";
    notes.push(
      tabWillClose
        ? `${reason} The tab was closed again; to read on, call open-and-read-tab with closeAfter=false, then read-tab with its tabId and offset=${end}.`
        : `${reason} Call read-tab with tabId=${tabId} and offset=${end} for more.`
    );
  }
  if (opts.format === "markdown" && !markdown) {
    notes.push("Markdown needs the FireMCP add-on; the connected add-on sent plain text.");
  }
  if ((opts.selector || opts.excludeSelector || opts.mainContentOnly) && !content.scoped) {
    notes.push("selector, excludeSelector and mainContentOnly need the FireMCP add-on; the connected add-on sent the whole page.");
  }
  if (opts.includeLinks && slim.droppedLinks > 0) {
    notes.push(`${slim.droppedLinks} duplicate or surplus links omitted.`);
  }

  const result: TextContent[] = [header];
  if (notes.length) result.push({ type: "text", text: notes.join(" ") });
  const redact = (text: string) => (opts.redactPersonalData ? redactPersonalData(text) : text);
  result.push({ type: "text", text: redact(slim.text) });
  if (slim.links.length) {
    result.push({
      type: "text",
      text: "Links:\n" + slim.links.map((l) => `- ${redact(l.text)} <${l.url}>`).join("\n"),
    });
  }
  return result;
}

async function openAndRead(
  input: string,
  opts: OpenReadOptions
): Promise<{ content: TextContent[]; isError?: boolean }> {
  const { url, note } = normalizeOpenUrl(input);
  const tabId = await browserApi.openTab(url, opts.background ? false : undefined);
  if (tabId === undefined) {
    return { content: [{ type: "text", text: "Failed to open tab" }], isError: true };
  }

  let keepOpen = !opts.closeAfter;
  try {
    const { loaded, tab: loadedTab } = await waitForTabComplete(tabId, opts.timeoutMs);
    if (loadedTab.url === "about:blank") {
      throw new Error(`${url} did not start loading within timeoutMs=${opts.timeoutMs} ms.`);
    }
    if (opts.settleMs > 0) await sleep(opts.settleMs);

    let read: { content: TabContentExtensionMessage; textFound?: boolean };
    try {
      read = await readWhenStable(
        loadedTab,
        opts.offset,
        opts.maxSettleMs,
        opts.consentWaitMs,
        opts.waitForText,
        contentOptions(opts)
      );
    } catch (error) {
      // Keep the tab, so read-tab can pick it up once the user has granted access.
      if (error instanceof ConsentPendingError) keepOpen = true;
      throw error;
    }
    const content = await extendToMaxChars(loadedTab, opts.offset, read.content, opts.maxChars, contentOptions(opts));

    // Title and final URL (after redirects) are often only known after rendering.
    const tab = (await browserApi.getTabList()).find((t) => t.id === tabId) ?? loadedTab;
    const result = formatTabContent(tab, opts.offset, content, opts, !keepOpen);
    const notes = [
      note,
      loaded ? undefined : `Page had not finished loading after ${opts.timeoutMs} ms; content may be incomplete.`,
      read.textFound === false
        ? `"${opts.waitForText}" did not appear within maxSettleMs=${opts.maxSettleMs} ms; returning what the page shows.`
        : undefined,
      keepOpen ? `Tab stays open as tab id ${tabId}.` : undefined,
    ].filter(Boolean);
    if (notes.length) {
      result.splice(1, 0, { type: "text", text: notes.join(" ") });
    }
    return { content: result };
  } finally {
    if (!keepOpen) {
      await browserApi.closeTabs([tabId]).catch(() => undefined);
    }
  }
}

// Same tab choice for every reading tool: tabId, else best match, else the
// active web page.
function selectTab(
  tabs: BrowserTab[],
  match: string | undefined,
  tabId: number | undefined
): { tab?: BrowserTab; others: BrowserTab[]; missing: { content: TextContent[]; isError: true } } {
  let tab: BrowserTab | undefined;
  let others: BrowserTab[] = [];
  if (tabId !== undefined) {
    tab = tabs.find((t) => t.id === tabId);
  } else if (match) {
    ({ best: tab, others } = matchTabs(tabs, match));
  } else {
    tab = pickActiveTab(tabs, true);
  }
  const wanted = tabId !== undefined ? `id ${tabId}` : match ? `"${match}"` : "a web page";
  return {
    tab,
    others,
    missing: {
      content: [{ type: "text", text: `No open tab matches ${wanted}. Use open-and-read-tab to open the URL.` }],
      isError: true,
    },
  };
}

// Scripts cannot run in an unloaded tab. Work on a fresh copy in a temporary tab
// instead of waking the original; the copy closes again unless it still waits
// for the user's domain consent.
async function withTemporaryTab<T>(
  url: string,
  consentWaitMs: number,
  use: (tab: BrowserTab) => Promise<T>
): Promise<T> {
  const { url: target } = normalizeOpenUrl(url);
  const tabId = await browserApi.openTab(target, false);
  if (tabId === undefined) {
    throw new Error(`Failed to open a temporary tab for ${url}`);
  }
  let keepOpen = false;
  try {
    const { tab } = await waitForTabComplete(tabId, DEFAULT_LOAD_TIMEOUT_MS);
    await sleep(DEFAULT_SETTLE_MS);
    await readWhenStable(tab, 0, DEFAULT_MAX_SETTLE_MS, consentWaitMs);
    return await use(tab);
  } catch (error) {
    if (error instanceof ConsentPendingError) keepOpen = true;
    throw error;
  } finally {
    if (!keepOpen) {
      await browserApi.closeTabs([tabId]).catch(() => undefined);
    }
  }
}

async function readOneTab(tab: BrowserTab, offset: number, opts: SlimReadOptions): Promise<TextContent[]> {
  if (tab.discarded && tab.url) {
    const result = await withTemporaryTab(tab.url, opts.consentWaitMs, async (copy) => {
      const first = await fetchTabContent(copy, offset, 0, contentOptions(opts));
      const content = await extendToMaxChars(copy, offset, first, opts.maxChars, contentOptions(opts));
      return formatTabContent(copy, offset, content, opts, true);
    });
    result.splice(1, 0, {
      type: "text",
      text: `Tab ${tab.id} is unloaded (discarded), so a fresh copy was read in a temporary tab.`,
    });
    return result;
  }
  const first = await fetchTabContent(tab, offset, opts.consentWaitMs, contentOptions(opts));
  const content = await extendToMaxChars(tab, offset, first, opts.maxChars, contentOptions(opts));
  return formatTabContent(tab, offset, content, opts);
}

// Searching covers the whole page, so it may read more chunks than reading does.
const MAX_SEARCH_CHUNKS = 20;

async function fetchWholePage(
  tab: BrowserTab,
  consentWaitMs: number
): Promise<{ text: string; totalLength: number; complete: boolean }> {
  let content = await fetchTabContent(tab, 0, consentWaitMs);
  let text = content.fullText;
  for (let chunks = 1; content.isTruncated && chunks < MAX_SEARCH_CHUNKS; chunks++) {
    content = await fetchTabContent(tab, text.length, 0);
    if (!content.fullText) break;
    text += content.fullText;
  }
  return { text, totalLength: content.totalLength, complete: text.length >= content.totalLength };
}

registerTool(
  "read-tab",
  `Read the text of an open tab in one step, found by URL or title fragment (or by tabId).
   Without match and tabId it reads the active tab. Prefer this over
   get-list-of-open-tabs followed by get-tab-web-content. Long pages come in parts of
   up to maxChars characters; continue with the offset named in the reply.`,
  {
    match: z
      .string()
      .optional()
      .describe("Case insensitive fragment(s) of the tab URL or title, e.g. 'x.com/rohan' or 'Karakeep'. Several words must all match."),
    tabId: z.number().optional(),
    offset: z.number().int().min(0).default(0),
    ...slimParams,
  },
  READS_WEB,
  async ({ match, tabId, offset, ...opts }) => {
    const { tab, others, missing } = selectTab(await browserApi.getTabList(), match, tabId);
    if (!tab) return missing;

    const result = await readOneTab(tab, offset, opts);
    if (others.length) {
      result.splice(1, 0, {
        type: "text",
        text:
          `${others.length} other matching tab(s), picked the best match. Others:\n` +
          others.slice(0, 10).map(formatTabLine).join("\n"),
      });
    }
    return { content: result };
  }
);

registerTool(
  "read-tabs",
  `Read several open tabs in one call, chosen by URL or title fragments and/or tab ids.
   The character budget is shared evenly; a tab that fails is reported without
   stopping the others.`,
  {
    matches: z
      .array(z.string())
      .optional()
      .describe("URL or title fragments, one per tab, e.g. ['spiegel', 'heise vorsorge']"),
    tabIds: z.array(z.number()).optional(),
    maxCharsPerTab: z
      .number()
      .int()
      .min(500)
      .max(50_000)
      .optional()
      .describe(`Default: ${DEFAULT_MAX_CHARS} split evenly, at least 2000 per tab`),
    includeLinks: slimParams.includeLinks,
    maxLinks: slimParams.maxLinks,
    consentWaitMs: slimParams.consentWaitMs,
    format: slimParams.format,
    mainContentOnly: slimParams.mainContentOnly,
    excludeSelector: slimParams.excludeSelector,
    redactPersonalData: slimParams.redactPersonalData,
  },
  READS_WEB,
  async ({ matches = [], tabIds = [], maxCharsPerTab, ...opts }) => {
    const tabs = await browserApi.getTabList();
    const targets: { label: string; tab?: BrowserTab }[] = [
      ...tabIds.map((id) => ({ label: `id ${id}`, tab: tabs.find((t) => t.id === id) })),
      ...matches.map((match) => ({ label: `"${match}"`, tab: matchTabs(tabs, match).best })),
    ];
    if (targets.length === 0) {
      return { content: [{ type: "text", text: "Give matches or tabIds." }], isError: true };
    }
    if (targets.length > 20) {
      return { content: [{ type: "text", text: "At most 20 tabs per call." }], isError: true };
    }

    // The same tab can be named twice (by id and by fragment); read it once.
    const seen = new Set<number>();
    const unique = targets.filter(({ tab }) => !tab || (!seen.has(tab.id as number) && seen.add(tab.id as number)));
    const maxChars = maxCharsPerTab ?? Math.max(2000, Math.floor(DEFAULT_MAX_CHARS / unique.length));

    const content: TextContent[] = [];
    let failed = 0;
    for (const { label, tab } of unique) {
      if (!tab) {
        failed++;
        content.push({ type: "text", text: `No open tab matches ${label}.` });
        continue;
      }
      try {
        content.push(...(await readOneTab(tab, 0, { ...opts, maxChars })));
      } catch (error) {
        failed++;
        content.push({ type: "text", text: `${formatTabLine(tab)}: ${errorText(error)}` });
      }
    }
    content.unshift({
      type: "text",
      text: `Read ${unique.length - failed} of ${unique.length} tabs, up to ${maxChars} characters each.`,
    });
    return { content };
  }
);

registerTool(
  "search-tab",
  `Find text in an open tab without reading all of it: returns short snippets around each
   hit with its character offset (read more with read-tab and that offset). Searches the
   whole page, not just the first chunk. The tab is chosen like in read-tab.`,
  {
    query: z
      .string()
      .min(1)
      .describe("Phrase to find, ignoring case and spacing. Separate several phrases with |, e.g. 'Habeck | Grüne'"),
    match: z.string().optional().describe("URL or title fragment of the tab, as in read-tab"),
    tabId: z.number().optional(),
    contextChars: z.number().int().min(20).max(2000).default(200).describe("Characters shown before and after each hit"),
    maxResults: z.number().int().min(1).max(100).default(10),
    consentWaitMs: slimParams.consentWaitMs,
    redactPersonalData: slimParams.redactPersonalData,
  },
  READS_WEB,
  async ({ query, match, tabId, contextChars, maxResults, consentWaitMs, redactPersonalData: redact }) => {
    const { tab, missing } = selectTab(await browserApi.getTabList(), match, tabId);
    if (!tab) return missing;

    const phrases = query.split("|").map((phrase) => phrase.trim()).filter(Boolean);
    const searched =
      tab.discarded && tab.url
        ? await withTemporaryTab(tab.url, consentWaitMs, (copy) => fetchWholePage(copy, 0))
        : await fetchWholePage(tab, consentWaitMs);
    const found = findSnippets(searched.text, phrases, { contextChars, maxResults });

    const counts = found.counts.map(({ phrase, count }) => `"${phrase}": ${count} hit${count === 1 ? "" : "s"}`).join(", ");
    const notes = [
      `${formatTabLine(tab)}, ${searched.text.length} of ${searched.totalLength} characters searched.`,
      `${counts}.`,
      found.totalSnippets > found.snippets.length
        ? `Showing ${found.snippets.length} of ${found.totalSnippets} snippets; raise maxResults for more.`
        : undefined,
      searched.complete ? undefined : "The page is longer than the search limit; later text was not searched.",
      tab.discarded ? `Tab ${tab.id} is unloaded, so a fresh copy was searched in a temporary tab.` : undefined,
      found.snippets.length && !tab.discarded
        ? `Read around a hit with read-tab tabId=${tab.id} and an offset a little before the hit.`
        : undefined,
    ].filter(Boolean);

    const content: TextContent[] = [{ type: "text", text: notes.join(" ") }];
    if (found.snippets.length) {
      content.push({
        type: "text",
        text: found.snippets
          // Markers inside an address would hide it from redaction: redact the plain text, then mark again.
          .map((snippet) => {
            const text = redact ? markPhrases(redactPersonalData(snippet.text.replace(/[«»]/g, "")), phrases) : snippet.text;
            return `[offset ${snippet.offset}] ${text}`;
          })
          .join("\n\n"),
      });
    }
    return { content };
  }
);

registerTool(
  "open-and-read-tabs",
  `Open several https URLs one after another in background tabs, read each once it has
   rendered and close it again. The character budget is shared evenly; a page that fails
   is reported without stopping the others. Use instead of repeated open-and-read-tab calls.`,
  {
    urls: z.array(z.string()).min(1).max(10),
    maxCharsPerPage: z
      .number()
      .int()
      .min(500)
      .max(50_000)
      .optional()
      .describe(`Default: ${DEFAULT_MAX_CHARS} split evenly, at least 2000 per page`),
    keepOpen: z.boolean().default(false).describe("Leave the tabs open, e.g. to read on with read-tab"),
    settleMs: z.number().int().min(0).max(15_000).default(DEFAULT_SETTLE_MS),
    maxSettleMs: z.number().int().min(0).max(30_000).default(DEFAULT_MAX_SETTLE_MS),
    timeoutMs: z.number().int().min(1000).max(60_000).default(DEFAULT_LOAD_TIMEOUT_MS),
    includeLinks: slimParams.includeLinks,
    maxLinks: slimParams.maxLinks,
    consentWaitMs: slimParams.consentWaitMs,
    format: slimParams.format,
    mainContentOnly: slimParams.mainContentOnly,
    redactPersonalData: slimParams.redactPersonalData,
  },
  OPENS_PAGES,
  async ({ urls, maxCharsPerPage, keepOpen, ...opts }) => {
    const maxChars = maxCharsPerPage ?? Math.max(2000, Math.floor(DEFAULT_MAX_CHARS / urls.length));
    const content: TextContent[] = [];
    let failed = 0;
    for (const url of urls) {
      try {
        const page = await openAndRead(url, { ...opts, maxChars, offset: 0, closeAfter: !keepOpen, background: true });
        if (page.isError) failed++;
        content.push(...page.content);
      } catch (error) {
        failed++;
        content.push({ type: "text", text: `${url}: ${errorText(error)}` });
      }
    }
    content.unshift({
      type: "text",
      text: `Read ${urls.length - failed} of ${urls.length} pages, up to ${maxChars} characters each.`,
    });
    return { content };
  }
);

// Features of the own extension build: fail with a clear message on the stock add-on.
async function requireExtensionCommand(command: string, feature: string): Promise<void> {
  const info = await browserApi.getExtensionInfo();
  if (info?.commands.includes(command)) return;
  throw new Error(
    info
      ? `${feature} needs a newer FireMCP add-on; the connected version ${info.version} does not support it.`
      : `${feature} needs the FireMCP add-on. The connected add-on is the original Browser Control MCP from addons.mozilla.org, which does not support it.`
  );
}

function formatPageMeta(meta: PageMeta): string {
  const pairs = (record: Record<string, string>) =>
    Object.entries(record)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ");
  const lines = [
    `Title: ${meta.title}`,
    meta.lang && `Language: ${meta.lang}`,
    meta.description && `Description: ${meta.description}`,
    meta.canonical && `Canonical: ${meta.canonical}`,
    meta.robots && `Robots: ${meta.robots}`,
    Object.keys(meta.openGraph).length && `Open Graph: ${pairs(meta.openGraph)}`,
    Object.keys(meta.twitter).length && `Twitter: ${pairs(meta.twitter)}`,
    meta.alternates.length && `Alternates: ${meta.alternates.map((a) => `${a.hreflang} ${a.href}`).join(", ")}`,
    meta.headings.length && `Headings:\n${meta.headings.map((h) => `${"#".repeat(h.level)} ${h.text}`).join("\n")}`,
    meta.jsonLd.length && `JSON-LD (${meta.jsonLd.length} block${meta.jsonLd.length === 1 ? "" : "s"}):\n${JSON.stringify(meta.jsonLd, null, 1)}`,
  ];
  return lines.filter(Boolean).join("\n");
}

registerTool(
  "read-page-meta",
  `Read a tab's metadata instead of its text: title, meta description, canonical URL,
   robots, Open Graph and Twitter tags, hreflang alternates, JSON-LD structured data and
   the h1 to h3 outline. The tab is chosen like in read-tab. Needs the FireMCP add-on.`,
  {
    match: z.string().optional().describe("URL or title fragment of the tab, as in read-tab"),
    tabId: z.number().optional(),
    consentWaitMs: slimParams.consentWaitMs,
  },
  READS_WEB,
  async ({ match, tabId, consentWaitMs }) => {
    await requireExtensionCommand("get-page-meta", "Reading page metadata");
    const { tab, missing } = selectTab(await browserApi.getTabList(), match, tabId);
    if (!tab) return missing;

    const meta =
      tab.discarded && tab.url
        ? await withTemporaryTab(tab.url, consentWaitMs, (copy) => browserApi.getPageMeta(copy.id as number))
        : await withDomainConsent(tab, consentWaitMs, () => browserApi.getPageMeta(tab.id as number));
    return {
      content: [
        { type: "text", text: formatTabLine(tab) },
        { type: "text", text: formatPageMeta(meta) },
      ],
    };
  }
);

registerTool(
  "read-selection",
  `Read the text the user has selected in a tab (default: the active tab), for example
   when they say "this paragraph" or "what I marked". Needs the FireMCP add-on.`,
  {
    match: z.string().optional().describe("URL or title fragment of the tab, as in read-tab"),
    tabId: z.number().optional(),
  },
  READS_WEB,
  async ({ match, tabId }) => {
    await requireExtensionCommand("get-selection", "Reading the selection");
    const { tab, missing } = selectTab(await browserApi.getTabList(), match, tabId);
    if (!tab) return missing;
    if (tab.discarded) {
      return { content: [{ type: "text", text: `Tab ${tab.id} is unloaded, so nothing can be selected in it.` }], isError: true };
    }

    const text = await withDomainConsent(tab, 0, () => browserApi.getSelection(tab.id as number));
    return {
      content: [
        { type: "text", text: formatTabLine(tab) },
        { type: "text", text: text.trim() ? text : "Nothing is selected in this tab." },
      ],
    };
  }
);

registerTool(
  "search-bookmarks",
  `Search the user's bookmarks by words in title or URL; returns title, URL, folder and
   date added. The first use asks the user for the bookmarks permission. Needs the FireMCP add-on.`,
  {
    query: z.string().min(1),
    limit: z.number().int().min(1).max(200).default(50),
    consentWaitMs: consentWaitParam("bookmarks are searched"),
  },
  READS_BROWSER,
  async ({ query, limit, consentWaitMs }) => {
    await requireExtensionCommand("search-bookmarks", "Searching bookmarks");
    const items = await withFeatureConsent("bookmarks", consentWaitMs, () => browserApi.searchBookmarks(query, limit));
    if (items.length === 0) {
      return { content: [{ type: "text", text: `No bookmarks match "${query}".` }] };
    }
    const lines = items.map((item) => {
      const added = item.dateAdded ? `, added ${dayjs(item.dateAdded).format("YYYY-MM-DD")}` : "";
      return `title="${item.title}", url=${item.url}, folder=${item.folder || "-"}${added}`;
    });
    return { content: [{ type: "text", text: [`${items.length} bookmarks`, ...lines].join("\n") }] };
  }
);

registerTool(
  "open-and-read-tab",
  `Open an https URL in a new tab, wait until it has loaded and rendered, and return its text
   in one call. Use for live pages where a plain web fetch returns stale or empty content.
   Long pages come in parts of up to maxChars characters; keep the tab open (closeAfter=false)
   to read on with read-tab and the offset named in the reply.`,
  {
    url: z.string().describe("https URL; bare domains get https:// and http:// is upgraded"),
    settleMs: z
      .number()
      .int()
      .min(0)
      .max(15_000)
      .default(DEFAULT_SETTLE_MS)
      .describe("Wait after load before the first read"),
    maxSettleMs: z
      .number()
      .int()
      .min(0)
      .max(30_000)
      .default(DEFAULT_MAX_SETTLE_MS)
      .describe("Upper bound for re-reading until the text stops changing (script rendered pages)"),
    timeoutMs: z.number().int().min(1000).max(60_000).default(DEFAULT_LOAD_TIMEOUT_MS),
    closeAfter: z.boolean().default(false).describe("Close the tab again after reading"),
    waitForText: z
      .string()
      .optional()
      .describe("Read as soon as this text appears on the page (case insensitive) instead of waiting for the text to stop changing. Bounded by maxSettleMs."),
    background: z
      .boolean()
      .optional()
      .describe("Open without switching to the tab. Default: true with closeAfter. Needs the FireMCP add-on, the original add-on always switches."),
    ...slimParams,
  },
  OPENS_PAGES,
  async ({ url, background, ...opts }) =>
    openAndRead(url, { ...opts, background: background ?? opts.closeAfter, offset: 0 })
);

if (toolProfile !== "all" && toolProfile !== "read") {
  const unknown = toolProfile
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry && !knownToolNames.includes(entry));
  if (unknown.length) {
    console.error(`firemcp: BROWSER_MCP_TOOLS names unknown tools: ${unknown.join(", ")}`);
  }
}

const browserApi = new BrowserAPI();
browserApi.init().catch((err) => {
  console.error("Browser API init error", err);
  process.exit(1);
});

const transport = new StdioServerTransport();
mcpServer.connect(transport).catch((err) => {
  console.error("MCP Server connection error", err);
  process.exit(1);
});

process.stdin.on("close", async () => {
  await browserApi.close();
  mcpServer.close();
  process.exit(0);
});
