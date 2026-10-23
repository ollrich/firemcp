import type { BrowserTab } from "@browser-control-mcp/common";

export interface PageLink {
  url: string;
  text: string;
}

export interface SlimOptions {
  includeLinks: boolean;
  maxLinks: number;
  maxChars: number;
  pageUrl?: string;
  // Defaults to compactText; markdown needs its indentation kept.
  compact?: (text: string) => string;
}

export interface SlimResult {
  text: string;
  links: PageLink[];
  droppedLinks: number;
  cutByMaxChars: boolean;
  // Characters of the raw input that the returned text covers. Offsets into the
  // page refer to raw innerText, so continuation offsets build on this.
  rawConsumed: number;
}

/**
 * Collapse the whitespace noise that document.body.innerText produces
 * (runs of blank lines, trailing spaces, tab soup from layout tables).
 */
export function compactText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Lighter cleanup for markdown: keeps indentation of lists and code. */
export function compactMarkdown(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Raw prefix length that covers the first `compactLength` characters of the
 * compacted text, ending right after its last non-whitespace character so that
 * nothing is skipped when reading on from there. Compacting a prefix yields a
 * prefix of the compacted whole (minus trailing whitespace), so the lengths grow
 * monotonically and a binary search finds the boundary.
 */
export function rawLengthForCompactPrefix(
  raw: string,
  compactLength: number,
  compact: (text: string) => string = compactText
): number {
  const target = compact(raw).slice(0, compactLength).trimEnd().length;
  if (target === 0) {
    return 0;
  }
  let low = 0;
  let high = raw.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (compact(raw.slice(0, mid)).length >= target) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return low;
}

function normalizeUrlForCompare(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

/**
 * Deduplicate links by URL, drop self links and cap the number of links.
 * Keeps the first (usually most prominent) occurrence of each URL.
 */
export function slimLinks(
  links: PageLink[],
  maxLinks: number,
  pageUrl?: string
): { links: PageLink[]; dropped: number } {
  const self = pageUrl ? normalizeUrlForCompare(pageUrl) : undefined;
  const seen = new Set<string>();
  const unique: PageLink[] = [];
  for (const link of links) {
    const key = normalizeUrlForCompare(link.url);
    if (key === self || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push({ url: link.url, text: compactText(link.text).slice(0, 120) });
  }
  const kept = unique.slice(0, Math.max(0, maxLinks));
  return { links: kept, dropped: links.length - kept.length };
}

export function slimContent(
  fullText: string,
  links: PageLink[],
  options: SlimOptions
): SlimResult {
  const compact = options.compact ?? compactText;
  let text = compact(fullText);
  let cutByMaxChars = false;
  let rawConsumed = fullText.length;
  if (options.maxChars > 0 && text.length > options.maxChars) {
    text = text.slice(0, options.maxChars);
    cutByMaxChars = true;
    rawConsumed = rawLengthForCompactPrefix(fullText, options.maxChars, compact);
  }

  if (!options.includeLinks) {
    return { text, links: [], droppedLinks: links.length, cutByMaxChars, rawConsumed };
  }

  const slimmed = slimLinks(links, options.maxLinks, options.pageUrl);
  return {
    text,
    links: slimmed.links,
    droppedLinks: slimmed.dropped,
    cutByMaxChars,
    rawConsumed,
  };
}

/** Tabs whose text the extension can read: web pages, not about:, moz-extension: or file:. */
export function isReadableTab(tab: BrowserTab): boolean {
  return tab.id !== undefined && /^https?:\/\//i.test(tab.url ?? "");
}

/**
 * The tab the user is most likely looking at: active tabs first (one per window),
 * then the most recently accessed. lastAccessed alone can point at a background
 * window or at the extension's own consent page.
 */
export function pickActiveTab(tabs: BrowserTab[], readableOnly = false): BrowserTab | undefined {
  return tabs
    .filter((tab) => tab.id !== undefined && (!readableOnly || isReadableTab(tab)))
    .sort(
      (a, b) =>
        Number(Boolean(b.active)) - Number(Boolean(a.active)) ||
        (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)
    )[0];
}

export interface TabMatchResult {
  best?: BrowserTab;
  others: BrowserTab[];
}

function stripSchemeAndWww(value: string): string {
  return value.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^www\./, "");
}

function urlMatchKey(url: string): string {
  return stripSchemeAndWww(normalizeUrlForCompare(url.trim())).replace(/\/$/, "");
}

/**
 * Find readable tabs matching every whitespace separated term of the query in
 * their URL or title (case insensitive, scheme and "www." ignored). An exact URL
 * match wins; otherwise tabs matching more terms in the URL rank first, then the
 * most recently accessed.
 */
export function matchTabs(tabs: BrowserTab[], query: string): TabMatchResult {
  const terms = query
    .trim()
    .split(/\s+/)
    .map((term) => stripSchemeAndWww(term).replace(/\/+$/, ""))
    .filter(Boolean);
  if (!terms.length) {
    return { others: [] };
  }

  const scored: { tab: BrowserTab; urlHits: number }[] = [];
  for (const tab of tabs) {
    if (!isReadableTab(tab)) continue;
    const url = stripSchemeAndWww(tab.url ?? "");
    const title = (tab.title ?? "").toLowerCase();
    let urlHits = 0;
    const matchesAll = terms.every((term) => {
      if (url.includes(term)) {
        urlHits++;
        return true;
      }
      return title.includes(term);
    });
    if (matchesAll) {
      scored.push({ tab, urlHits });
    }
  }

  const exactKey = urlMatchKey(query);
  const exact = scored.find(({ tab }) => urlMatchKey(tab.url ?? "") === exactKey)?.tab;
  const sorted = scored
    .sort(
      (a, b) =>
        b.urlHits - a.urlHits || (b.tab.lastAccessed ?? 0) - (a.tab.lastAccessed ?? 0)
    )
    .map(({ tab }) => tab);
  const best = exact ?? sorted[0];
  return { best, others: sorted.filter((tab) => tab !== best) };
}

export function formatTabLine(tab: BrowserTab): string {
  return `tab id=${tab.id}, url=${tab.url}, title=${tab.title}`;
}

/** Tab state worth knowing before reading it. */
export function tabFlags(tab: BrowserTab): string[] {
  const flags: string[] = [];
  if (tab.active) flags.push("active");
  if (tab.discarded) flags.push("unloaded");
  if (tab.status === "loading") flags.push("loading");
  if (tab.hidden) flags.push("hidden");
  if (tab.pinned) flags.push("pinned");
  return flags;
}

/** Tabs whose URL or title contains every whitespace separated term (any scheme). */
export function filterTabs(tabs: BrowserTab[], query: string): BrowserTab[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tabs.filter((tab) => {
    const haystack = `${tab.url ?? ""} ${tab.title ?? ""}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export interface Snippet {
  // Raw page offset of the first hit, usable as read-tab offset.
  offset: number;
  text: string;
}

export interface SnippetResult {
  counts: { phrase: string; count: number }[];
  snippets: Snippet[];
  // Snippets found in total, before maxResults.
  totalSnippets: number;
}

function phrasePattern(phrase: string): RegExp | undefined {
  const words = phrase
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return words.length ? new RegExp(words.join("\\s+"), "gi") : undefined;
}

/**
 * Find phrases in raw page text (case insensitive, any whitespace between
 * words) and cut a snippet of contextChars around each hit. Hits whose
 * snippets overlap share one snippet; hits are marked with «».
 */
export function findSnippets(
  raw: string,
  phrases: string[],
  options: { contextChars: number; maxResults: number }
): SnippetResult {
  const hits: { start: number; end: number }[] = [];
  const counts: { phrase: string; count: number }[] = [];
  for (const phrase of phrases) {
    const pattern = phrasePattern(phrase);
    if (!pattern) continue;
    let count = 0;
    for (const match of raw.matchAll(pattern)) {
      count++;
      hits.push({ start: match.index, end: match.index + match[0].length });
    }
    counts.push({ phrase: phrase.trim().replace(/\s+/g, " "), count });
  }
  hits.sort((a, b) => a.start - b.start);

  // Dense hits would otherwise merge into one snippet as long as the page.
  const maxWindow = Math.max(4 * options.contextChars, 300);
  const windows: { from: number; to: number; marks: { start: number; end: number }[] }[] = [];
  for (const hit of hits) {
    const from = Math.max(0, hit.start - options.contextChars);
    const to = Math.min(raw.length, hit.end + options.contextChars);
    const last = windows[windows.length - 1];
    if (last && from <= last.to && to - last.from <= maxWindow) {
      last.to = Math.max(last.to, to);
      last.marks.push(hit);
    } else {
      windows.push({ from, to, marks: [hit] });
    }
  }

  const snippets = windows.slice(0, options.maxResults).map((window) => {
    let text = "";
    let position = window.from;
    for (const mark of window.marks) {
      // Hits of different phrases can overlap; mark the first one only.
      if (mark.start < position) continue;
      text += `${raw.slice(position, mark.start)}«${raw.slice(mark.start, mark.end)}»`;
      position = mark.end;
    }
    text += raw.slice(position, window.to);
    const before = window.from > 0 ? "…" : "";
    const after = window.to < raw.length ? "…" : "";
    return { offset: window.marks[0].start, text: `${before}${text.replace(/\s+/g, " ").trim()}${after}` };
  });

  return { counts, snippets, totalSnippets: windows.length };
}

/**
 * History and bookmark URLs can run past a thousand characters (signed download
 * links, tracking parameters). Long ones lose their query, then their tail; the
 * title next to them still says what the page is.
 */
export function shortenUrl(url: string, maxLength = 300): string {
  if (url.length <= maxLength) return url;
  const query = url.search(/[?#]/);
  const base = query === -1 ? url : url.slice(0, query);
  const short = base.length + 2 <= maxLength ? `${base}?…` : `${url.slice(0, maxLength)}…`;
  return `${short} (shortened from ${url.length} characters)`;
}

/**
 * Accept what people type: bare domains get https://, http:// is upgraded
 * because the extension only opens https URLs.
 */
export function normalizeOpenUrl(input: string): { url: string; note?: string } {
  const trimmed = input.trim();
  if (/^https:\/\//i.test(trimmed)) {
    return { url: trimmed };
  }
  if (/^http:\/\//i.test(trimmed)) {
    const url = `https://${trimmed.slice("http://".length)}`;
    return { url, note: `Opened ${url} instead of ${trimmed}: the extension only opens https URLs.` };
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  if (!hasScheme && /^[^\s/]+\.[^\s/]+/.test(trimmed)) {
    const url = `https://${trimmed}`;
    return { url, note: `Opened ${url}.` };
  }
  throw new Error(`Only https URLs can be opened, got "${input}".`);
}

/**
 * The extension's consent page for a new domain: options.html?requestUrl=<page>.
 * It closes itself once the user grants access.
 */
export function isConsentTabFor(tab: BrowserTab, pageUrl: string | undefined): boolean {
  if (!pageUrl || !tab.url?.startsWith("moz-extension://")) {
    return false;
  }
  try {
    const requested = new URL(tab.url).searchParams.get("requestUrl");
    return requested !== null && new URL(requested).origin === new URL(pageUrl).origin;
  } catch {
    return false;
  }
}

/**
 * The extension's consent page for an optional permission such as history or
 * bookmarks: options.html?requestPermissions=["history"]. It closes itself once
 * the user grants it.
 */
export function isFeatureConsentTabFor(tab: BrowserTab, permission: string): boolean {
  if (!tab.url?.startsWith("moz-extension://")) {
    return false;
  }
  try {
    const requested: unknown = JSON.parse(new URL(tab.url).searchParams.get("requestPermissions") ?? "[]");
    return Array.isArray(requested) && requested.includes(permission);
  } catch {
    return false;
  }
}

function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/**
 * Mask personal data in text handed to the model: e-mail addresses, IBANs,
 * card numbers (Luhn checked) and phone numbers in international (+49, 0049,
 * also with the trunk zero as [0] or (0)) or German (0 plus area code)
 * notation, including a short extension like -0. Deliberately conservative:
 * dates, prices and plain numbers stay.
 */
export function redactPersonalData(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
    .replace(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g, "[iban]")
    .replace(/\b(?:\d[ -]?){12,18}\d\b/g, (match) =>
      passesLuhn(match.replace(/\D/g, "")) ? "[card]" : match
    )
    .replace(/(?:\+|\b00)\d{1,3}[ /.-]?(?:[[(]0[\])][ /.-]?)?\(?\d{1,5}\)?(?:[ /.-]?\d{2,}){1,4}(?:-\d{1,4})?(?!\d)/g, "[phone]")
    .replace(/\b0\d{2,5}[ /-]\d{3,}(?:[ -]\d{2,})*(?:-\d{1,4})?(?!\d)/g, "[phone]");
}

/** Mark phrase hits with «» again, e.g. after the snippet text was redacted. */
export function markPhrases(text: string, phrases: string[]): string {
  return phrases.reduce((marked, phrase) => {
    const pattern = phrasePattern(phrase);
    return pattern ? marked.replace(pattern, "«$&»") : marked;
  }, text);
}
