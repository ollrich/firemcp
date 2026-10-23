import { collectPageMeta, collectSelection, pageToMarkdown } from "../page-scripts";

// The extension injects these functions as source text, so run them that way too.
function runInjected<T>(fn: () => T): T {
  return new Function(`return (${fn.toString()})()`)() as T;
}

describe("page scripts", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("collects meta tags, JSON-LD and headings from injected source", () => {
    document.documentElement.lang = "de";
    document.head.innerHTML = `
      <meta name="description" content=" A description ">
      <meta name="robots" content="noindex">
      <link rel="canonical" href="https://example.com/page">
      <link rel="alternate" hreflang="en" href="https://example.com/en/page">
      <meta property="og:title" content="OG title">
      <meta property="og:title" content="Second og title is ignored">
      <meta name="twitter:card" content="summary">
      <script type="application/ld+json">{"@type": "Article", "headline": "Hi"}</script>
      <script type="application/ld+json">{ broken</script>`;
    document.body.innerHTML = "<h1>Main  title</h1><h2>Part</h2><h3></h3><h4>Too deep</h4>";
    document.title = "Example page";

    const meta = runInjected(collectPageMeta);

    expect(meta).toEqual({
      title: "Example page",
      lang: "de",
      description: "A description",
      canonical: "https://example.com/page",
      robots: "noindex",
      openGraph: { title: "OG title" },
      twitter: { card: "summary" },
      alternates: [{ hreflang: "en", href: "https://example.com/en/page" }],
      jsonLd: [{ "@type": "Article", headline: "Hi" }, { unparsable: "{ broken" }],
      headings: [
        { level: 1, text: "Main title" },
        { level: 2, text: "Part" },
      ],
    });
  });

  it("reads the page selection, then a selection inside a text field, never a password", () => {
    document.body.innerHTML = `<p id="p">Hello selected world</p><textarea id="t">field text</textarea><input id="pw" type="password" value="secret">`;

    const range = document.createRange();
    range.selectNodeContents(document.getElementById("p") as HTMLElement);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    expect(runInjected(collectSelection)).toBe("Hello selected world");

    window.getSelection()?.removeAllRanges();
    const textarea = document.getElementById("t") as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(0, 5);
    expect(runInjected(collectSelection)).toBe("field");

    const password = document.getElementById("pw") as HTMLInputElement;
    password.focus();
    password.setSelectionRange(0, 6);
    expect(runInjected(collectSelection)).toBe("");
  });

  it("converts the visible page to markdown from injected source", () => {
    document.body.innerHTML = `
      <nav>Menu <a href="https://example.com/home">Home</a></nav>
      <main>
        <h1>Main   title</h1>
        <p>Text with <a href="https://example.com/x">a link</a>, <strong>bold</strong> and <code>code()</code>.<br>Next line</p>
        <div style="display:none">hidden text</div>
        <ul><li>One<ul><li>Nested</li></ul></li><li>Two</li></ul>
        <ol><li>First</li><li>Second</li></ol>
        <blockquote><p>Quoted</p></blockquote>
        <pre>  indented()

  more()</pre>
        <table><tr><th>Name</th><th>Value</th></tr><tr><td>a|b</td><td>1</td></tr></table>
        <script>ignored()</script>
      </main>`;

    const run = (root: string, exclude: string | null, links: boolean) =>
      new Function("root", "exclude", "links", `return (${pageToMarkdown.toString()})(root, exclude, links)`)(
        document.querySelector(root),
        exclude,
        links
      ) as string;
    const markdown = run("main", null, true);

    expect(markdown).toBe(
      [
        "# Main title",
        "Text with [a link](https://example.com/x), **bold** and `code()`.\nNext line",
        "- One\n  - Nested\n- Two",
        "1. First\n2. Second",
        "> Quoted",
        "```\n  indented()\n\n  more()\n```",
        "| Name | Value |\n| --- | --- |\n| a\\|b | 1 |",
      ].join("\n\n")
    );

    const whole = run("body", null, false);
    expect(whole.startsWith("Menu Home")).toBe(true);
    expect(whole).toContain("Text with a link,");

    const trimmed = run("main", "table, blockquote", true);
    expect(trimmed).not.toContain("Quoted");
    expect(trimmed).not.toContain("| Name |");
    expect(trimmed).toContain("1. First");
  });

  it("keeps the structure of blocks inside custom elements and inline wrappers", () => {
    document.body.innerHTML = `
      <turbo-frame id="content"><h2>Release</h2><release-body><p>Intro</p><ul><li>One</li><li>Two</li></ul></release-body></turbo-frame>
      <p>Card: <a href="https://example.com/c"><div>Card title</div></a> <span>stays inline</span></p>`;
    const markdown = new Function("root", "exclude", "links", `return (${pageToMarkdown.toString()})(root, exclude, links)`)(
      document.body,
      null,
      false
    ) as string;
    expect(markdown).toBe(["## Release", "Intro", "- One\n- Two", "Card:", "Card title", "stays inline"].join("\n\n"));
  });
});
