import assert from "node:assert/strict";
import test from "node:test";

import utils from "../dist/content-utils.js";

const {
  compactText,
  slimLinks,
  slimContent,
  matchTabs,
  rawLengthForCompactPrefix,
  pickActiveTab,
  normalizeOpenUrl,
  isConsentTabFor,
  isFeatureConsentTabFor,
  findSnippets,
  filterTabs,
  tabFlags,
  compactMarkdown,
} = utils;

test("compactMarkdown keeps indentation but drops trailing spaces and blank runs", () => {
  const markdown = "# T  \r\n\n\n\n- a\n  - b   \n\n```\n    code\n```  ";
  assert.equal(compactMarkdown(markdown), "# T\n\n- a\n  - b\n\n```\n    code\n```");
  const res = slimContent(markdown, [], { includeLinks: false, maxLinks: 0, maxChars: 8, compact: compactMarkdown });
  assert.equal(res.text, "# T\n\n- a");
  assert.equal(compactMarkdown(markdown.slice(0, res.rawConsumed)), "# T\n\n- a");
});

test("findSnippets marks hits, merges close ones and keeps raw offsets", () => {
  const raw = "Intro text.\n\nThe Green   Party met. Later the green party voted.\n" + "x".repeat(500) + " green party again";
  const res = findSnippets(raw, ["green party", "  ", "nothing"], { contextChars: 15, maxResults: 10 });
  assert.deepEqual(res.counts, [
    { phrase: "green party", count: 3 },
    { phrase: "nothing", count: 0 },
  ]);
  assert.equal(res.totalSnippets, 2, "the first two hits share one snippet");
  assert.equal(res.snippets[0].offset, raw.indexOf("Green"));
  assert.match(res.snippets[0].text, /^…tro text\. The «Green Party» met\. Later the «green party» voted\./);
  assert.match(res.snippets[1].text, /«green party» again$/);
  assert.equal(findSnippets(raw, ["green party"], { contextChars: 15, maxResults: 1 }).snippets.length, 1);
  assert.equal(findSnippets("a (b) c", ["(b)"], { contextChars: 5, maxResults: 5 }).counts[0].count, 1, "regex characters are literal");
});

test("filterTabs and tabFlags", () => {
  const tabs = [
    { id: 1, url: "about:preferences", title: "Settings", active: true },
    { id: 2, url: "https://github.com/x", title: "Repo", discarded: true, pinned: true },
  ];
  assert.deepEqual(filterTabs(tabs, "settings").map((t) => t.id), [1], "non web tabs can be listed");
  assert.deepEqual(filterTabs(tabs, "github repo").map((t) => t.id), [2]);
  assert.deepEqual(tabFlags(tabs[0]), ["active"]);
  assert.deepEqual(tabFlags({ ...tabs[1], status: "loading" }), ["unloaded", "loading", "pinned"]);
});

test("compactText collapses blank lines and space runs", () => {
  const input = "Title\r\n\r\n\r\n\r\n  Body   text\t\twith  gaps \n\n\n\nEnd  ";
  assert.equal(compactText(input), "Title\n\nBody text with gaps\n\nEnd");
});

test("slimLinks dedupes by URL ignoring hash and trailing slash, drops self links", () => {
  const links = [
    { url: "https://a.de/page", text: "self" },
    { url: "https://a.de/x", text: "X" },
    { url: "https://a.de/x/", text: "X again" },
    { url: "https://a.de/x#frag", text: "X frag" },
    { url: "https://a.de/y", text: "  Y   spaced " },
  ];
  const { links: out, dropped } = slimLinks(links, 10, "https://a.de/page#top");
  assert.deepEqual(out, [
    { url: "https://a.de/x", text: "X" },
    { url: "https://a.de/y", text: "Y spaced" },
  ]);
  assert.equal(dropped, 3);
});

test("slimLinks respects maxLinks", () => {
  const links = Array.from({ length: 50 }, (_, i) => ({ url: `https://a.de/${i}`, text: `${i}` }));
  const { links: out, dropped } = slimLinks(links, 5);
  assert.equal(out.length, 5);
  assert.equal(dropped, 45);
});

test("slimContent omits links by default flag and applies maxChars", () => {
  const res = slimContent("abcdefghij", [{ url: "https://a.de/1", text: "1" }], {
    includeLinks: false,
    maxLinks: 40,
    maxChars: 4,
  });
  assert.equal(res.text, "abcd");
  assert.equal(res.cutByMaxChars, true);
  assert.deepEqual(res.links, []);
});

test("matchTabs prefers exact URL, else most recent, case insensitive", () => {
  const tabs = [
    { id: 1, url: "https://x.com/rohan/status/1", title: "Post A", lastAccessed: 100 },
    { id: 2, url: "https://x.com/rohan/status/2", title: "Post B", lastAccessed: 300 },
    { id: 3, url: "https://karakeep.app", title: "Karakeep", lastAccessed: 200 },
    { url: "https://no-id.example", title: "no id" },
  ];
  let r = matchTabs(tabs, "X.COM/rohan");
  assert.equal(r.best.id, 2);
  assert.deepEqual(r.others.map((t) => t.id), [1]);

  r = matchTabs(tabs, "https://x.com/rohan/status/1");
  assert.equal(r.best.id, 1);

  r = matchTabs(tabs, "karakeep");
  assert.equal(r.best.id, 3);

  assert.equal(matchTabs(tabs, "nothing").best, undefined);
  assert.equal(matchTabs(tabs, "  ").best, undefined);
});

test("matchTabs needs all terms, ranks URL hits first and skips non web tabs", () => {
  const tabs = [
    { id: 1, url: "https://news.example/a", title: "Karakeep review", lastAccessed: 900 },
    { id: 2, url: "https://www.karakeep.app/review", title: "Docs", lastAccessed: 100 },
    { id: 3, url: "moz-extension://abc/options.html?requestUrl=karakeep", title: "Karakeep", lastAccessed: 999 },
  ];
  assert.equal(matchTabs(tabs, "karakeep").best.id, 2, "URL hit beats a newer title hit");
  assert.equal(matchTabs(tabs, "karakeep review").best.id, 2);
  assert.equal(matchTabs(tabs, "karakeep news").best.id, 1);
  assert.equal(matchTabs(tabs, "karakeep missing").best, undefined);
  assert.equal(matchTabs(tabs, "http://karakeep.app/review/").best.id, 2, "scheme, www and trailing slash ignored");
  assert.ok(!matchTabs(tabs, "options").best, "extension pages are not readable");
});

test("rawLengthForCompactPrefix maps a cut in compacted text back to raw text", () => {
  const raw = "  Alpha   beta\n\n\n\ngamma  delta ";
  const compact = compactText(raw);
  for (let k = 1; k <= compact.length; k++) {
    const r = rawLengthForCompactPrefix(raw, k);
    assert.equal(compactText(raw.slice(0, r)), compact.slice(0, k).trimEnd(), `k=${k}`);
  }
  const res = slimContent(raw, [], { includeLinks: false, maxLinks: 0, maxChars: 8 });
  assert.equal(res.text, "Alpha be");
  assert.equal(raw.slice(0, res.rawConsumed).trim(), "Alpha   be");
  assert.equal(slimContent(raw, [], { includeLinks: false, maxLinks: 0, maxChars: 0 }).rawConsumed, raw.length);
});

test("pickActiveTab prefers active tabs, optionally only web pages", () => {
  const tabs = [
    { id: 1, url: "https://a.example", lastAccessed: 100, active: true },
    { id: 2, url: "https://b.example", lastAccessed: 500, active: false },
    { id: 3, url: "about:preferences", lastAccessed: 300, active: true },
  ];
  assert.equal(pickActiveTab(tabs).id, 3);
  assert.equal(pickActiveTab(tabs, true).id, 1);
  assert.equal(pickActiveTab([], true), undefined);
});

test("normalizeOpenUrl adds or upgrades to https and rejects other schemes", () => {
  assert.deepEqual(normalizeOpenUrl(" https://a.example/x "), { url: "https://a.example/x" });
  assert.equal(normalizeOpenUrl("http://a.example").url, "https://a.example");
  assert.match(normalizeOpenUrl("http://a.example").note, /only opens https/);
  assert.equal(normalizeOpenUrl("a.example/path").url, "https://a.example/path");
  assert.throws(() => normalizeOpenUrl("ftp://a.example"), /Only https/);
  assert.throws(() => normalizeOpenUrl("not a url"), /Only https/);
});

test("isConsentTabFor recognizes the extension's consent page by origin", () => {
  const consent = {
    id: 9,
    url: `moz-extension://uuid/options.html?requestUrl=${encodeURIComponent("https://a.example/page?x=1")}`,
  };
  assert.equal(isConsentTabFor(consent, "https://a.example/other"), true);
  assert.equal(isConsentTabFor(consent, "https://b.example/page"), false);
  assert.equal(isConsentTabFor({ id: 1, url: "https://a.example" }, "https://a.example"), false);
  assert.equal(isConsentTabFor(consent, undefined), false);
});

test("isFeatureConsentTabFor recognizes the consent page for an optional permission", () => {
  const consent = {
    id: 9,
    url: `moz-extension://uuid/options.html?requestPermissions=${encodeURIComponent(JSON.stringify(["bookmarks"]))}`,
  };
  assert.equal(isFeatureConsentTabFor(consent, "bookmarks"), true);
  assert.equal(isFeatureConsentTabFor(consent, "history"), false);
  assert.equal(isFeatureConsentTabFor({ id: 1, url: "moz-extension://uuid/options.html?requestPermissions=%5Bbroken" }, "history"), false);
  assert.equal(isFeatureConsentTabFor({ id: 1, url: "https://a.example/?requestPermissions=%5B%22history%22%5D" }, "history"), false);
});

test("redactPersonalData masks contact and payment data but keeps ordinary numbers", () => {
  const { redactPersonalData } = utils;
  const text = [
    "Mail max.mustermann+news@example.co.uk or info@firma.de.",
    "Call +49 30 1234567, 0049 89/123456 or 030 1234567.",
    "Imprint: +49 [0]511 5352-0, fax +49 (0)511 5352-129, local 0511 5352-129.",
    "IBAN DE89 3704 0044 0532 0130 00 and card 4111 1111 1111 1111.",
    "Not a card: 1234 5678 9012 3456. Date 22.10.2026, price 19,99 EUR, order 2026-10-22, year 1990.",
  ].join("\n");
  assert.equal(
    redactPersonalData(text),
    [
      "Mail [email] or [email].",
      "Call [phone], [phone] or [phone].",
      "Imprint: [phone], fax [phone], local [phone].",
      "IBAN [iban] and card [card].",
      "Not a card: 1234 5678 9012 3456. Date 22.10.2026, price 19,99 EUR, order 2026-10-22, year 1990.",
    ].join("\n")
  );
});
