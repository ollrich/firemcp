import type { PageMeta } from "@browser-control-mcp/common";

// Functions that run inside a page via tabs.executeScript. Only their source
// text is sent (`(${fn.toString()})()`), so each must be self contained: no
// imports, no outer variables, only types from outside.

export function collectPageMeta(): PageMeta {
  const attribute = (selector: string, name: string) =>
    document.querySelector(selector)?.getAttribute(name)?.trim() || undefined;
  const metaByPrefix = (prefix: string) => {
    const found: Record<string, string> = {};
    document.querySelectorAll(`meta[property^="${prefix}"], meta[name^="${prefix}"]`).forEach((element) => {
      const key = (element.getAttribute("property") || element.getAttribute("name") || "").slice(prefix.length);
      const value = element.getAttribute("content");
      if (key && value && !(key in found)) {
        found[key] = value.trim();
      }
    });
    return found;
  };

  const jsonLd: unknown[] = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach((element) => {
    const source = element.textContent || "";
    try {
      jsonLd.push(JSON.parse(source));
    } catch {
      jsonLd.push({ unparsable: source.slice(0, 500) });
    }
  });

  return {
    title: document.title,
    lang: document.documentElement.lang || undefined,
    description: attribute('meta[name="description"]', "content"),
    canonical: attribute('link[rel="canonical"]', "href"),
    robots: attribute('meta[name="robots"]', "content"),
    openGraph: metaByPrefix("og:"),
    twitter: metaByPrefix("twitter:"),
    alternates: Array.from(document.querySelectorAll('link[rel="alternate"][hreflang]')).map((element) => ({
      hreflang: element.getAttribute("hreflang") || "",
      href: (element as HTMLLinkElement).href,
    })),
    jsonLd,
    headings: Array.from(document.querySelectorAll("h1, h2, h3"))
      .map((element) => ({
        level: Number(element.tagName.slice(1)),
        text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
      }))
      .filter((heading) => heading.text)
      .slice(0, 60),
  };
}

export function collectSelection(): string {
  const selected = window.getSelection()?.toString() ?? "";
  if (selected.trim()) {
    return selected;
  }
  // Text selected inside a form field is not part of window.getSelection().
  const field = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  if (
    field &&
    (field.tagName === "TEXTAREA" || (field.tagName === "INPUT" && field.type !== "password")) &&
    typeof field.selectionStart === "number" &&
    typeof field.selectionEnd === "number" &&
    field.selectionEnd > field.selectionStart
  ) {
    return field.value.slice(field.selectionStart, field.selectionEnd);
  }
  return "";
}

// innerText of root without the elements matching exclude (best effort: their
// text is cut out of the root's text).
export function visibleText(root: HTMLElement, exclude: string | null): string {
  let text = root.innerText;
  if (exclude) {
    for (const element of Array.from(root.querySelectorAll<HTMLElement>(exclude))) {
      const part = element.innerText;
      if (part) text = text.replace(part, "");
    }
  }
  return text;
}

// Markdown of the visible content of root: headings, paragraphs, lists, links,
// emphasis, code, quotes and tables, leaving out elements matching exclude.
export function pageToMarkdown(root: HTMLElement, exclude: string | null, inlineLinks: boolean): string {
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "OBJECT", "BUTTON", "SELECT", "INPUT", "TEXTAREA", "HEAD"]);
  const BLOCK = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BODY", "DD", "DETAILS", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION",
    "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P",
    "PRE", "SECTION", "SUMMARY", "TABLE", "UL",
  ]);
  // Custom elements (GitHub's <turbo-frame>, Reddit's <shreddit-post>) and inline
  // wrappers such as a link around a card can hold blocks; walk those as blocks so
  // their headings, paragraphs and lists keep their structure.
  const BLOCK_SELECTOR = Array.from(BLOCK).join(",");
  const isBlock = (element: Element) => BLOCK.has(element.tagName) || element.querySelector(BLOCK_SELECTOR) !== null;
  const isHidden = (element: Element): boolean => {
    if ((element as HTMLElement).hidden || element.getAttribute("aria-hidden") === "true") return true;
    const checkVisibility = (element as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility;
    if (typeof checkVisibility === "function") return !checkVisibility.call(element);
    const style = window.getComputedStyle(element);
    return style.display === "none" || style.visibility === "hidden";
  };
  const skipped = (element: Element) =>
    SKIP.has(element.tagName) || isHidden(element) || (exclude !== null && element.matches(exclude));

  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent || "").replace(/\s+/g, " ");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const element = node as HTMLElement;
    if (skipped(element)) return "";
    const inner = () => Array.from(element.childNodes).map(inline).join("");
    switch (element.tagName) {
      case "BR":
        return "\n";
      case "A": {
        const text = inner().trim();
        const href = (element as HTMLAnchorElement).href;
        return inlineLinks && text && /^https?:/.test(href) ? `[${text}](${href})` : text;
      }
      case "STRONG":
      case "B": {
        const text = inner().trim();
        return text ? `**${text}**` : "";
      }
      case "EM":
      case "I": {
        const text = inner().trim();
        return text ? `*${text}*` : "";
      }
      case "CODE": {
        const text = element.textContent || "";
        return text ? `\`${text}\`` : "";
      }
      case "IMG": {
        const alt = element.getAttribute("alt")?.trim();
        return alt ? `[image: ${alt}]` : "";
      }
      default:
        return inner();
    }
  };

  const blocks: string[] = [];
  const push = (text: string, quote: string, keepLines = false) => {
    const lines = text.split("\n").map((line) => (keepLines ? line.replace(/\s+$/, "") : line.trim()));
    const joined = (keepLines ? lines.join("\n") : lines.join("\n").replace(/\n{2,}/g, "\n")).trim();
    if (joined) blocks.push(quote ? joined.split("\n").map((line) => quote + line).join("\n") : joined);
  };

  const listLines = (list: HTMLElement, depth: number): string[] => {
    const lines: string[] = [];
    let number = 1;
    for (const item of Array.from(list.children)) {
      if (item.tagName !== "LI" || skipped(item)) continue;
      const nested: HTMLElement[] = [];
      let text = "";
      for (const child of Array.from(item.childNodes)) {
        const tag = (child as Element).tagName;
        if (tag === "UL" || tag === "OL") nested.push(child as HTMLElement);
        else text += inline(child);
      }
      const marker = list.tagName === "OL" ? `${number++}.` : "-";
      lines.push(`${"  ".repeat(depth)}${marker} ${text.replace(/\s+/g, " ").trim()}`);
      for (const sublist of nested) lines.push(...listLines(sublist, depth + 1));
    }
    return lines;
  };

  const tableMarkdown = (table: HTMLElement): string => {
    const rows = Array.from(table.querySelectorAll("tr")).map((row) =>
      Array.from(row.children)
        .filter((cell) => cell.tagName === "TD" || cell.tagName === "TH")
        .map((cell) => inline(cell).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim())
    );
    if (!rows.length) return "";
    const width = Math.max(...rows.map((row) => row.length));
    const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;
    return [line(rows[0]), `| ${Array(width).fill("---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
  };

  const walk = (element: HTMLElement, quote: string) => {
    if (skipped(element)) return;
    const tag = element.tagName;
    if (/^H[1-6]$/.test(tag)) return push(`${"#".repeat(Number(tag[1]))} ${inline(element).replace(/\s+/g, " ")}`, quote);
    if (tag === "PRE") return push(`\`\`\`\n${(element.textContent || "").replace(/\n+$/, "")}\n\`\`\``, quote, true);
    if (tag === "HR") return push("---", quote);
    if (tag === "UL" || tag === "OL") return push(listLines(element, 0).join("\n"), quote, true);
    if (tag === "TABLE") return push(tableMarkdown(element), quote, true);
    const innerQuote = tag === "BLOCKQUOTE" ? `${quote}> ` : quote;

    let run = "";
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE && isBlock(child as Element)) {
        push(run, innerQuote);
        run = "";
        walk(child as HTMLElement, innerQuote);
      } else {
        run += inline(child);
      }
    }
    push(run, innerQuote);
  };

  walk(root, "");
  return blocks.join("\n\n");
}
