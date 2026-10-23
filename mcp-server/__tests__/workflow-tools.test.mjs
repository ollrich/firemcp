// End to end: real MCP server processes over stdio, a fake Firefox extension
// that behaves like the stock AMO add-on (original commands only, unsigned
// errors for everything else, about:blank before navigation, consent dialog
// for new domains, unloaded tabs), plus a second server process acting as
// broker forwarder.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(here, "..", "dist", "server.js");
const SECRET = "test-secret-" + crypto.randomBytes(4).toString("hex");
const ORIGINAL_COMMANDS = ["close-tabs", "get-tab-content", "get-tab-list", "open-tab"];

async function freePort() {
  return await new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sign = (payload) => crypto.createHmac("sha256", SECRET).update(JSON.stringify(payload)).digest("hex");

const consentMessage = (origin) =>
  `The user has not yet granted permission to access the domain "${origin}". ` +
  "A dialog is now being opened to request permission. If the user grants permission, you can try the request again.";

// Fields the fake keeps for itself; everything else is sent like a tabs.Tab.
const publicTab = ({ text, reads, pendingUrl, blankPolls, loadingPolls, links, ...tab }) => tab;

function advanceLoading(state, tab) {
  if (tab.pendingUrl) {
    Object.assign(tab, { url: tab.pendingUrl, status: "loading", loadingPolls: 2, title: "Loading" }, state.pages[tab.pendingUrl] ?? { text: "Default page" });
    delete tab.pendingUrl;
  } else if (tab.status === "loading" && --tab.loadingPolls <= 0) {
    tab.status = "complete";
  }
}

function startFakeExtension(port, state) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on("message", (raw) => {
    const { payload } = JSON.parse(raw.toString());
    state.commands.push(payload.cmd);
    state.payloads.push(payload);
    const reply = (body) => {
      const p = { ...body, correlationId: payload.correlationId };
      ws.send(JSON.stringify({ payload: p, signature: sign(p) }));
    };
    // The add-on reports failures as unsigned error messages.
    const fail = (errorMessage) => ws.send(JSON.stringify({ correlationId: payload.correlationId, errorMessage }));

    switch (payload.cmd) {
      case "get-tab-list":
        reply({ resource: "tabs", tabs: state.tabs.map(publicTab) });
        for (const tab of state.tabs) advanceLoading(state, tab);
        break;
      case "open-tab": {
        const id = state.nextId++;
        // Firefox shows the new tab as a finished about:blank before navigating.
        state.tabs.push({ id, url: "about:blank", status: "complete", title: "New Tab", pendingUrl: payload.url, lastAccessed: Date.now(), active: true, reads: 0 });
        reply({ resource: "opened-tab-id", tabId: id });
        break;
      }
      case "close-tabs":
        state.tabs = state.tabs.filter((t) => !payload.tabIds.includes(t.id));
        reply({ resource: "tabs-closed" });
        break;
      case "get-browser-recent-history": {
        const query = (payload.searchQuery ?? "").toLowerCase();
        reply({
          resource: "history",
          historyItems: state.history.filter((item) => `${item.url} ${item.title}`.toLowerCase().includes(query)),
        });
        break;
      }
      case "get-tab-content": {
        const tab = state.tabs.find((t) => t.id === payload.tabId);
        if (!tab) return fail(`Invalid tab ID: ${payload.tabId}`);
        if (tab.url === "about:blank") return fail("Invalid url pattern: null/*");
        if (tab.discarded) return fail("Missing host permission for the tab");
        const origin = new URL(tab.url).origin;
        if (state.deniedOrigins.has(origin)) {
          state.tabs.push({
            id: state.nextId++,
            url: `moz-extension://fake-uuid/options.html?requestUrl=${encodeURIComponent(tab.url)}`,
            title: "FireMCP",
            status: "complete",
            lastAccessed: Date.now(),
          });
          state.onConsentRequested?.(origin);
          return fail(consentMessage(origin));
        }
        tab.reads = (tab.reads ?? 0) + 1;
        // An own 2.0 build honours format; the stock add-on ignores it.
        const markdown = state.ownBuild && payload.format === "markdown" && tab.markdown !== undefined;
        const scoped = Boolean(state.ownBuild && payload.selector);
        if (scoped && !tab.sections?.[payload.selector]) {
          return fail(`No element matches the selector "${payload.selector}"`);
        }
        const full = scoped
          ? tab.sections[payload.selector]
          : markdown ? tab.markdown : typeof tab.text === "function" ? tab.text(tab.reads) : tab.text;
        const rest = full.substring(payload.offset ?? 0);
        const page = rest.substring(0, state.pageCap);
        reply({
          resource: "tab-content",
          tabId: tab.id,
          fullText: page,
          isTruncated: rest.length > page.length,
          totalLength: full.length,
          links: tab.links ?? [],
          ...(markdown ? { format: "markdown" } : {}),
          ...(scoped ? { scoped } : {}),
        });
        break;
      }
      case "get-extension-info":
      case "get-page-meta":
      case "get-selection":
      case "search-bookmarks": {
        if (!state.ownBuild) return fail(`Command '${payload.cmd}' is disabled in extension settings`);
        const tab = state.tabs.find((t) => t.id === payload.tabId);
        if (payload.cmd === "get-extension-info") reply({ resource: "extension-info", version: "2.0.0", commands: state.ownBuild });
        if (payload.cmd === "get-page-meta") reply({ resource: "page-meta", tabId: tab.id, meta: tab.meta });
        if (payload.cmd === "get-selection") reply({ resource: "selection", tabId: tab.id, text: tab.selection ?? "" });
        if (payload.cmd === "search-bookmarks") {
          reply({ resource: "bookmarks", items: state.bookmarks.filter((b) => b.title.toLowerCase().includes(payload.query)) });
        }
        break;
      }
      default:
        // The stock add-on rejects commands it does not know.
        fail(`Command '${payload.cmd}' is disabled in extension settings`);
    }
  });
  return new Promise((resolve) => ws.on("open", () => resolve(ws)));
}

async function startClient(port, home, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverJs],
    env: { ...process.env, HOME: home, EXTENSION_SECRET: SECRET, EXTENSION_PORT: String(port), ...extraEnv },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return client;
}

const textOf = (res) => res.content.map((c) => c.text).join("\n---\n");
const count = (cmd) => state.commands.filter((c) => c === cmd).length;
const grantConsent = (origin) => {
  state.deniedOrigins.delete(origin);
  // The consent page closes itself after the user grants access.
  state.tabs = state.tabs.filter((t) => !t.url.startsWith("moz-extension://"));
};

const longText = "Rohan Nayak post\n\n\n\n\n" + "Pocket FM grew a lot.   ".repeat(30);
const state = {
  commands: [],
  payloads: [],
  // Command list of an own 2.0 build; false behaves like the stock add-on.
  ownBuild: false,
  nextId: 100,
  pageCap: 50_000,
  deniedOrigins: new Set(),
  pages: {},
  tabs: [],
  history: [
    { url: "https://news.example/today", title: "Today's news", lastVisitTime: Date.now() - 2 * 3_600_000 },
    { url: "https://news.example/old", title: "Old news", lastVisitTime: Date.now() - 50 * 3_600_000 },
    { url: "https://docs.example/guide", title: "Guide", lastVisitTime: Date.now() - 3 * 3_600_000 },
  ],
};
let port;
let home;
let leader;
let ext;

before(async () => {
  port = await freePort();
  // Deliberately below os.tmpdir(): on macOS that path is long enough to
  // overflow the unix socket limit, which the broker has to cope with.
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bcm-home-"));
  state.tabs = [
    { id: 1, url: "https://x.com/RohanNayak2/status/2098104784264065525", title: "Rohan on X", lastAccessed: 500, status: "complete", windowId: 1, active: false, text: longText,
      links: [
        { url: "https://x.com/RohanNayak2/status/2098104784264065525", text: "self" },
        { url: "https://pocketfm.com/", text: "Pocket FM" },
        { url: "https://pocketfm.com", text: "Pocket FM dup" },
      ] },
    { id: 2, url: "https://karakeep.app/dashboard", title: "Karakeep", lastAccessed: 900, status: "complete", windowId: 1, active: true, text: "Bookmarks list" },
    // Recently used, but not a readable web page.
    { id: 3, url: "about:preferences", title: "Settings", lastAccessed: 950, status: "complete", windowId: 2, active: true, text: "" },
  ];

  leader = await startClient(port, home);
  await new Promise((r) => setTimeout(r, 300));
  ext = await startFakeExtension(port, state);
});

after(async () => {
  await leader?.close();
  ext?.close();
});

test("tool list includes the workflow and screenshot tools", async () => {
  const tools = (await leader.listTools()).tools.map((x) => x.name);
  for (const name of ["read-tab", "open-and-read-tab", "capture-tab-screenshot"]) {
    assert.ok(tools.includes(name), name);
  }
});

test("every tool carries read only and destructive annotations", async () => {
  const tools = Object.fromEntries((await leader.listTools()).tools.map((x) => [x.name, x.annotations]));
  for (const [name, annotations] of Object.entries(tools)) {
    assert.equal(typeof annotations?.readOnlyHint, "boolean", name);
  }
  assert.equal(tools["read-tab"].readOnlyHint, true);
  assert.equal(tools["get-list-of-open-tabs"].readOnlyHint, true);
  assert.equal(tools["open-and-read-tab"].readOnlyHint, false);
  assert.equal(tools["close-browser-tabs"].destructiveHint, true);
});

test("read-tab finds tabs by fragment, compacts text and slims links", async () => {
  let res = await leader.callTool({ name: "read-tab", arguments: { match: "rohannayak2" } });
  let text = textOf(res);
  assert.match(text, /tab id=1/);
  assert.match(text, /Rohan Nayak post\n\nPocket FM/);
  assert.doesNotMatch(text, /Links:/);

  // Several words must all match, in URL or title.
  res = await leader.callTool({ name: "read-tab", arguments: { match: "x.com rohan", includeLinks: true } });
  text = textOf(res);
  assert.match(text, /tab id=1/);
  assert.match(text, /Links:\n- Pocket FM <https:\/\/pocketfm.com\/>/);
  assert.doesNotMatch(text, /Pocket FM dup/);
  assert.doesNotMatch(text, /- self/);
});

test("read-tab without arguments reads the active web page", async () => {
  const res = await leader.callTool({ name: "read-tab", arguments: {} });
  assert.match(textOf(res), /Bookmarks list/);
});

test("read-tab reports a missing tab as an error", async () => {
  let res = await leader.callTool({ name: "read-tab", arguments: { match: "does-not-exist" } });
  assert.equal(res.isError, true);
  res = await leader.callTool({ name: "read-tab", arguments: { match: "preferences" } });
  assert.equal(res.isError, true, "about: pages are not readable");
});

test("maxChars names an offset that continues exactly after the shown text", async () => {
  const first = await leader.callTool({ name: "read-tab", arguments: { tabId: 1, maxChars: 40 } });
  const next = textOf(first).match(/offset=(\d+)/);
  assert.ok(next, "continuation offset given");
  const second = await leader.callTool({ name: "read-tab", arguments: { tabId: 1, maxChars: 40, offset: Number(next[1]) } });

  const shown = (res) => res.content[res.content.length - 1].text;
  const squash = (s) => s.replace(/\s+/g, "");
  assert.ok(squash(longText).startsWith(squash(shown(first) + shown(second))));
});

test("open-and-read-tab skips about:blank and waits for script rendered text", async () => {
  state.commands.length = 0;
  state.pages["https://bsky.app/profile/test"] = {
    text: (reads) => (reads === 1 ? "Loading..." : "Real rendered profile content"),
  };
  const res = await leader.callTool({
    name: "open-and-read-tab",
    arguments: { url: "https://bsky.app/profile/test", settleMs: 100, closeAfter: true },
  });
  const text = textOf(res);
  assert.equal(res.isError, undefined, text);
  assert.match(text, /Real rendered profile content/);
  assert.doesNotMatch(text, /Loading\.\.\./);
  assert.ok(count("get-tab-list") >= 3, "polled until complete");
  assert.ok(count("get-tab-content") >= 2 && count("get-tab-content") <= 5, "re-read until stable");
  assert.ok(!state.tabs.some((t) => t.url === "https://bsky.app/profile/test"), "tab closed after reading");
  assert.deepEqual([...new Set(state.commands)].sort(), ORIGINAL_COMMANDS);
});

test("open-and-read-tab waits for domain consent, then reads", async () => {
  state.deniedOrigins.add("https://newsite.example");
  state.pages["https://newsite.example"] = { text: "Freshly allowed page" };
  // The user clicks "allow" shortly after the dialog shows up.
  state.onConsentRequested = (origin) => setTimeout(() => grantConsent(origin), 800);

  const res = await leader.callTool({
    name: "open-and-read-tab",
    arguments: { url: "newsite.example", settleMs: 0, consentWaitMs: 15_000 },
  });
  delete state.onConsentRequested;
  const text = textOf(res);
  assert.equal(res.isError, undefined, text);
  assert.match(text, /Freshly allowed page/);
  assert.match(text, /Opened https:\/\/newsite\.example\./);
  assert.match(text, /Tab stays open as tab id \d+/);
});

test("without waiting, a consent error names the tab to read later", async () => {
  state.deniedOrigins.add("https://karakeep.app");
  const res = await leader.callTool({ name: "read-tab", arguments: { tabId: 2, consentWaitMs: 0 } });
  grantConsent("https://karakeep.app");
  assert.equal(res.isError, true);
  assert.match(textOf(res), /not yet granted permission.*call read-tab with tabId=2/s);
});

test("read-tab reads an unloaded tab through a temporary tab", async () => {
  state.tabs.push({ id: 7, url: "https://old.example/article", title: "Old article", lastAccessed: 10, status: "complete", discarded: true, text: "stale" });
  state.pages["https://old.example/article"] = { text: "Fresh article text" };
  const tabCount = state.tabs.length;

  const res = await leader.callTool({ name: "read-tab", arguments: { match: "old.example" } });
  const text = textOf(res);
  assert.match(text, /Fresh article text/);
  assert.match(text, /Tab 7 is unloaded \(discarded\)/);
  assert.equal(state.tabs.length, tabCount, "temporary tab closed again");
});

test("get-current-tab and get-tab-metadata work with the stock add-on", async () => {
  state.commands.length = 0;
  let res = await leader.callTool({ name: "get-current-tab", arguments: {} });
  assert.match(textOf(res), /id=\d+/);
  res = await leader.callTool({ name: "get-tab-metadata", arguments: { tabId: 1 } });
  assert.equal(JSON.parse(res.content[0].text).url, state.tabs.find((t) => t.id === 1).url);
  assert.deepEqual([...new Set(state.commands)], ["get-tab-list"]);
});

test("open-browser-tab reports bad URLs as tool errors", async () => {
  const res = await leader.callTool({ name: "open-browser-tab", arguments: { url: "ftp://example.com" } });
  assert.equal(res.isError, true);
});

test("waitForText keeps reading until the text shows up", async () => {
  state.commands.length = 0;
  // Stable page chrome first; the wanted post renders a little later.
  const chrome = "Navigation and sidebar text. ".repeat(20);
  state.pages["https://slow.example/feed"] = {
    text: (reads) => (reads < 3 ? chrome : `${chrome}\nThe Target   Phrase is here`),
  };
  let res = await leader.callTool({
    name: "open-and-read-tab",
    arguments: { url: "https://slow.example/feed", settleMs: 0, closeAfter: true, waitForText: "target phrase" },
  });
  assert.match(textOf(res), /The Target Phrase is here/);
  assert.ok(count("get-tab-content") >= 3, "did not stop at the stable chrome");

  state.pages["https://slow.example/empty"] = { text: chrome };
  res = await leader.callTool({
    name: "open-and-read-tab",
    arguments: { url: "https://slow.example/empty", settleMs: 0, closeAfter: true, waitForText: "never there", maxSettleMs: 1200 },
  });
  assert.match(textOf(res), /"never there" did not appear within maxSettleMs=1200 ms/);
});

test("maxChars beyond one extension chunk fetches the following chunks", async () => {
  state.pageCap = 100;
  try {
    let res = await leader.callTool({ name: "read-tab", arguments: { tabId: 1, maxChars: 5000 } });
    let text = textOf(res);
    assert.match(text, new RegExp(`characters 0-${longText.length} of ${longText.length}`));
    assert.doesNotMatch(text, /offset=/, "whole page in one call");
    assert.equal((text.match(/Pocket FM grew a lot\./g) ?? []).length, 30);

    // The default cap is far above this small page, so it arrives whole as well.
    res = await leader.callTool({ name: "read-tab", arguments: { tabId: 1 } });
    assert.doesNotMatch(textOf(res), /offset=/);

    res = await leader.callTool({ name: "read-tab", arguments: { tabId: 1, maxChars: 50 } });
    assert.match(textOf(res), /Output was cut at maxChars=50\. Call read-tab with tabId=1 and offset=\d+/);
  } finally {
    state.pageCap = 50_000;
  }
});

test("without maxChars a reply stays at 40000 characters and names the offset", async () => {
  state.tabs.push({ id: 8, url: "https://long.example/book", title: "Long book", lastAccessed: 5, status: "complete", text: "word ".repeat(12_000) });
  const res = await leader.callTool({ name: "read-tab", arguments: { tabId: 8 } });
  const text = textOf(res);
  // The cut lands on a space, so reading on starts right after the last word.
  assert.match(text, /characters 0-39999 of 60000/);
  assert.match(text, /Output was cut at maxChars=40000\. Call read-tab with tabId=8 and offset=39999/);
  assert.equal(res.content[res.content.length - 1].text.length, 40_000);
});

test("search-tab returns marked snippets with offsets across the whole page", async () => {
  let res = await leader.callTool({ name: "search-tab", arguments: { tabId: 1, query: "rohan nayak | POCKET   fm", contextChars: 20, maxResults: 2 } });
  let text = textOf(res);
  assert.match(text, /"rohan nayak": 1 hit, "POCKET fm": 30 hits/);
  assert.match(text, /\[offset 0\] «Rohan Nayak» post/);
  assert.match(text, /«Pocket FM» grew/);
  assert.match(text, /Showing 2 of \d+ snippets/);

  // Hits beyond the first extension chunk are found as well.
  state.pageCap = 100;
  try {
    res = await leader.callTool({ name: "search-tab", arguments: { tabId: 1, query: "grew a lot", maxResults: 100 } });
    text = textOf(res);
    assert.match(text, /"grew a lot": 30 hits/);
    assert.match(text, new RegExp(`${longText.length} of ${longText.length} characters searched`));
  } finally {
    state.pageCap = 50_000;
  }

  res = await leader.callTool({ name: "search-tab", arguments: { match: "karakeep", query: "missing words" } });
  assert.match(textOf(res), /"missing words": 0 hits/);
});

test("search-tab searches an unloaded tab through a temporary copy", async () => {
  const tabCount = state.tabs.length;
  const res = await leader.callTool({ name: "search-tab", arguments: { tabId: 7, query: "article" } });
  const text = textOf(res);
  assert.match(text, /«article»/);
  assert.match(text, /Tab 7 is unloaded/);
  assert.equal(state.tabs.length, tabCount, "temporary tab closed again");
});

test("read-tabs reads several tabs once each and reports misses", async () => {
  const res = await leader.callTool({
    name: "read-tabs",
    arguments: { tabIds: [1], matches: ["rohannayak2", "karakeep", "nowhere-to-be-found"] },
  });
  const text = textOf(res);
  assert.match(text, /^Read 2 of 3 tabs, up to 13333 characters each\./);
  assert.match(text, /Rohan Nayak post/);
  assert.match(text, /Bookmarks list/);
  assert.match(text, /No open tab matches "nowhere-to-be-found"\./);
  assert.equal((text.match(/tab id=1,/g) ?? []).length, 1, "tab 1 read once");
});

test("the tab list filters, sorts and flags tabs in one block", async () => {
  let res = await leader.callTool({ name: "get-list-of-open-tabs", arguments: { match: "karakeep" } });
  assert.equal(res.content.length, 1);
  assert.match(res.content[0].text, /^Showing tabs 1-1 of 1 matching "karakeep"\ntab id=2, .*active/);

  res = await leader.callTool({ name: "get-list-of-open-tabs", arguments: { match: "old.example" } });
  assert.match(res.content[0].text, /tab id=7, .*unloaded/);

  res = await leader.callTool({ name: "get-list-of-open-tabs", arguments: { sort: "recent", limit: 1 } });
  assert.match(res.content[0].text, /use offset=1 to see more/);
});

test("browser history comes as one block, filtered by query and age", async () => {
  let res = await leader.callTool({ name: "get-recent-browser-history", arguments: { searchQuery: "news", sinceHours: 24 } });
  assert.equal(res.content.length, 1);
  assert.match(res.content[0].text, /^1 of 1 pages\nurl=https:\/\/news\.example\/today/);

  res = await leader.callTool({ name: "get-recent-browser-history", arguments: { limit: 2 } });
  const lines = res.content[0].text.split("\n");
  assert.equal(lines[0], "2 of 3 pages (raise limit to see more)");
  assert.match(lines[1], /today/, "newest first");
});

test("BROWSER_MCP_TOOLS limits the offered tools", async () => {
  const readOnly = await startClient(port, home, { BROWSER_MCP_TOOLS: "read" });
  const picked = await startClient(port, home, { BROWSER_MCP_TOOLS: "read-tab, search-tab" });
  try {
    const names = (await readOnly.listTools()).tools.map((tool) => tool.name);
    for (const name of ["read-tab", "read-tabs", "search-tab", "open-and-read-tab", "open-browser-tab", "capture-tab-screenshot"]) {
      assert.ok(names.includes(name), name);
    }
    for (const name of ["close-browser-tabs", "reorder-browser-tabs", "group-browser-tabs", "find-highlight-in-browser-tab"]) {
      assert.ok(!names.includes(name), name);
    }
    assert.deepEqual((await picked.listTools()).tools.map((tool) => tool.name).sort(), ["read-tab", "search-tab"]);
  } finally {
    await readOnly.close();
    await picked.close();
  }
});

test("temporary tabs open in the background and links are only requested when wanted", async () => {
  state.payloads.length = 0;
  state.pages["https://quiet.example"] = { text: "Quiet page" };
  await leader.callTool({ name: "open-and-read-tab", arguments: { url: "https://quiet.example", settleMs: 0, closeAfter: true } });
  assert.equal(state.payloads.find((p) => p.cmd === "open-tab").active, false);
  assert.ok(state.payloads.filter((p) => p.cmd === "get-tab-content").every((p) => p.includeLinks === false));

  state.payloads.length = 0;
  await leader.callTool({ name: "read-tab", arguments: { tabId: 1, includeLinks: true } });
  assert.equal(state.payloads.find((p) => p.cmd === "get-tab-content").includeLinks, true);

  state.payloads.length = 0;
  await leader.callTool({ name: "open-and-read-tab", arguments: { url: "https://quiet.example", settleMs: 0 } });
  assert.equal(state.payloads.find((p) => p.cmd === "open-tab").active, undefined, "kept tabs open in front");
});

test("markdown falls back to text on the stock add-on with a note", async () => {
  const res = await leader.callTool({ name: "read-tab", arguments: { tabId: 2, format: "markdown" } });
  const text = textOf(res);
  assert.match(text, /Markdown needs the FireMCP add-on; the connected add-on sent plain text\./);
  assert.match(text, /Bookmarks list/);
});

test("selectors fall back to the whole page on the stock add-on with a note", async () => {
  const res = await leader.callTool({ name: "read-tab", arguments: { tabId: 2, selector: "#stats" } });
  const text = textOf(res);
  assert.match(text, /selector, excludeSelector and mainContentOnly need the FireMCP add-on; the connected add-on sent the whole page\./);
  assert.match(text, /Bookmarks list/);
});

test("extension 2.0 tools explain what they need on the stock add-on", async () => {
  for (const [name, args] of [
    ["read-page-meta", { tabId: 2 }],
    ["read-selection", { tabId: 2 }],
    ["search-bookmarks", { query: "paper" }],
  ]) {
    const res = await leader.callTool({ name, arguments: args });
    assert.equal(res.isError, true, name);
    assert.match(textOf(res), /needs the FireMCP add-on\. The connected add-on is the original Browser Control MCP/, name);
  }
});

test("extension 2.0 tools work against an own build", async () => {
  // A new connection, so the server repeats the handshake.
  state.ownBuild = ["get-extension-info", "get-page-meta", "get-selection", "search-bookmarks"];
  ext.close();
  ext = await startFakeExtension(port, state);
  const karakeep = state.tabs.find((t) => t.id === 2);
  karakeep.meta = {
    title: "Karakeep",
    lang: "en",
    description: "Bookmark everything",
    canonical: "https://karakeep.app/",
    openGraph: { title: "Karakeep" },
    twitter: {},
    alternates: [],
    jsonLd: [{ "@type": "WebApplication" }],
    headings: [{ level: 1, text: "Dashboard" }],
  };
  karakeep.selection = "marked words";
  state.bookmarks = [
    { title: "Paper on tabs", url: "https://papers.example/1", folder: "Bookmarks Menu / Research", dateAdded: Date.UTC(2026, 9, 1) },
  ];
  try {
    let res = await leader.callTool({ name: "read-page-meta", arguments: { match: "karakeep" } });
    let text = textOf(res);
    assert.match(text, /Description: Bookmark everything/);
    assert.match(text, /Open Graph: title=Karakeep/);
    assert.match(text, /# Dashboard/);
    assert.match(text, /JSON-LD \(1 block\)/);

    res = await leader.callTool({ name: "read-selection", arguments: { tabId: 2 } });
    assert.match(textOf(res), /marked words/);

    karakeep.markdown = "# Dashboard\n\n- Saved\n  - Nested   item\n\n```\n  indented()\n```";
    state.payloads.length = 0;
    res = await leader.callTool({ name: "read-tab", arguments: { tabId: 2, format: "markdown", mainContentOnly: true } });
    text = textOf(res);
    assert.match(text, /# Dashboard\n\n- Saved\n  - Nested   item\n\n```\n  indented\(\)\n```/, "indentation kept");
    assert.doesNotMatch(text, /Markdown needs extension 2\.0/);
    assert.deepEqual(
      (({ format, mainContentOnly }) => ({ format, mainContentOnly }))(state.payloads.find((p) => p.cmd === "get-tab-content")),
      { format: "markdown", mainContentOnly: true }
    );

    karakeep.sections = { "#stats": "42 bookmarks saved" };
    res = await leader.callTool({ name: "read-tab", arguments: { tabId: 2, selector: "#stats" } });
    text = textOf(res);
    assert.match(text, /42 bookmarks saved/);
    assert.doesNotMatch(text, /need the FireMCP add-on/);
    res = await leader.callTool({ name: "read-tab", arguments: { tabId: 2, selector: "#missing" } });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /No element matches the selector "#missing"/);

    res = await leader.callTool({ name: "search-bookmarks", arguments: { query: "paper" } });
    assert.match(textOf(res), /title="Paper on tabs", url=https:\/\/papers\.example\/1, folder=Bookmarks Menu \/ Research, added 2026-10-01/);
  } finally {
    state.ownBuild = false;
    ext.close();
    ext = await startFakeExtension(port, state);
  }
});

test("open-and-read-tabs reads several URLs, closes them and reports failures", async () => {
  state.pages["https://one.example"] = { text: "First page, write to team@one.example" };
  state.pages["https://two.example"] = { text: "Second page, call +49 30 1234567" };
  const tabCount = state.tabs.length;
  state.payloads.length = 0;

  const res = await leader.callTool({
    name: "open-and-read-tabs",
    arguments: { urls: ["one.example", "https://two.example", "ftp://three.example"], settleMs: 0, redactPersonalData: true },
  });
  const text = textOf(res);
  assert.match(text, /^Read 2 of 3 pages, up to 13333 characters each\./);
  assert.match(text, /First page, write to \[email\]/);
  assert.match(text, /Second page, call \[phone\]/);
  assert.match(text, /ftp:\/\/three\.example: Only https URLs can be opened/);
  assert.equal(state.tabs.length, tabCount, "all tabs closed again");
  assert.ok(state.payloads.filter((p) => p.cmd === "open-tab").every((p) => p.active === false), "opened in the background");
});

test("search-tab can mask personal data in snippets", async () => {
  state.tabs.push({ id: 9, url: "https://contact.example", title: "Contact", lastAccessed: 1, status: "complete", text: "Reach Anna at anna@contact.example today." });
  const res = await leader.callTool({ name: "search-tab", arguments: { tabId: 9, query: "anna", redactPersonalData: true } });
  assert.match(textOf(res), /«Anna» at \[email\]/);
});

test("a second session forwards through the broker", async () => {
  const forwarder = await startClient(port, home);
  try {
    await new Promise((r) => setTimeout(r, 500));
    const res = await forwarder.callTool({ name: "read-tab", arguments: { match: "karakeep" } });
    assert.match(textOf(res), /Bookmarks list/);
  } finally {
    await forwarder.close();
  }
});
