import type {
  ServerMessageRequest,
  TabContentExtensionMessage,
} from "@browser-control-mcp/common";
import { WebsocketClient } from "./client";
import { isCommandAllowed, isDomainInDenyList, COMMAND_TO_TOOL_ID, addAuditLogEntry } from "./extension-config";
import { hasCaptureConsent, markTabAsAwaitingConsent } from "./capture-consent";
import { collectPageMeta, collectSelection, pageToMarkdown, visibleText } from "./page-scripts";

const MAX_CONTENT_LENGTH = 50_000;
const MAX_TAB_CONTENT_RESPONSE_LENGTH = 2_000_000;
// Time to let a newly foregrounded tab paint before capturing it
const TAB_PAINT_DELAY_MS = 250;
// JSON-LD can be large (shops, recipes); keep the page meta response small.
const MAX_JSON_LD_LENGTH = 20_000;
const DEFAULT_BOOKMARK_LIMIT = 50;

export class MessageHandler {
  private client: WebsocketClient;

  constructor(client: WebsocketClient) {
    this.client = client;
  }

  public async handleDecodedMessage(req: ServerMessageRequest): Promise<void> {
    const isAllowed = await isCommandAllowed(req.cmd);
    if (!isAllowed) {
      throw new Error(`Command '${req.cmd}' is disabled in extension settings`);
    }

    // The handshake carries no user data, so it stays out of the audit log.
    if (req.cmd !== "get-extension-info") {
      this.addAuditLogForReq(req).catch((error) => {
        console.error("Failed to add audit log entry:", error);
      });
    }

    switch (req.cmd) {
      case "open-tab":
        await this.openUrl(req.correlationId, req.url, req.active);
        break;
      case "close-tabs":
        await this.closeTabs(req.correlationId, req.tabIds);
        break;
      case "get-tab-list":
        await this.sendTabs(req.correlationId);
        break;
      case "get-tab-metadata":
        await this.sendTabMetadata(req.correlationId, req.tabId);
        break;
      case "get-browser-recent-history":
        await this.sendRecentHistory(req.correlationId, req.searchQuery);
        break;
      case "get-tab-content":
        await this.sendTabsContent(req.correlationId, req.tabId, req.offset, req.includeLinks, req.format, {
          mainContentOnly: req.mainContentOnly,
          selector: req.selector,
          excludeSelector: req.excludeSelector,
        });
        break;
      case "reorder-tabs":
        await this.reorderTabs(req.correlationId, req.tabOrder);
        break;
      case "find-highlight":
        await this.findAndHighlightText(
          req.correlationId,
          req.tabId,
          req.queryPhrase
        );
        break;
      case "group-tabs":
        await this.groupTabs(
          req.correlationId,
          req.tabIds,
          req.isCollapsed,
          req.groupColor as browser.tabGroups.Color,
          req.groupTitle
        );
        break;
      case "get-current-tab":
        await this.sendCurrentTab(req.correlationId);
        break;
      case "get-extension-info":
        await this.sendExtensionInfo(req.correlationId);
        break;
      case "get-page-meta":
        await this.sendPageMeta(req.correlationId, req.tabId);
        break;
      case "get-selection":
        await this.sendSelection(req.correlationId, req.tabId);
        break;
      case "search-bookmarks":
        await this.sendBookmarks(req.correlationId, req.query, req.limit);
        break;
      case "capture-screenshot":
        await this.captureScreenshot(
          req.correlationId,
          req.tabId,
          req.format,
          req.quality,
          req.scale
        );
        break;
      default:
        const _exhaustiveCheck: never = req;
        console.error("Invalid message received:", req);
    }
  }

  private async addAuditLogForReq(req: ServerMessageRequest) {
    // Get the URL in context (either from param or from the tab)
    let contextUrl: string | undefined;
    if ("url" in req && req.url) {
      contextUrl = req.url;
    }
    if ("tabId" in req) {
      try {
        const tab = await browser.tabs.get(req.tabId);
        contextUrl = tab.url;
      } catch (error) {
        console.error("Failed to get tab URL for audit log:", error);
      }
    }

    const toolId = COMMAND_TO_TOOL_ID[req.cmd];
    const auditEntry = {
      toolId,
      command: req.cmd,
      timestamp: Date.now(),
      url: contextUrl
    };
    
    await addAuditLogEntry(auditEntry);
  }

  private async openUrl(correlationId: string, url: string, active = true): Promise<void> {
    if (!url.startsWith("https://")) {
      console.error("Invalid URL:", url);
      throw new Error("Invalid URL");
    }

    if (await isDomainInDenyList(url)) {
      throw new Error("Domain in user defined deny list");
    }

    const tab = await browser.tabs.create({
      url,
      active,
    });

    await this.client.sendResourceToServer({
      resource: "opened-tab-id",
      correlationId,
      tabId: tab.id,
    });
  }

  private async closeTabs(
    correlationId: string,
    tabIds: number[]
  ): Promise<void> {
    await browser.tabs.remove(tabIds);
    await this.client.sendResourceToServer({
      resource: "tabs-closed",
      correlationId,
    });
  }

  private async sendTabs(correlationId: string): Promise<void> {
    const tabs = await browser.tabs.query({});
    await this.client.sendResourceToServer({
      resource: "tabs",
      correlationId,
      tabs,
    });
  }

  private async sendCurrentTab(correlationId: string): Promise<void> {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    await this.client.sendResourceToServer({
      resource: "current-tab",
      correlationId,
      tab: tabs[0],
    });
  }

  private async sendTabMetadata(
    correlationId: string,
    tabId: number
  ): Promise<void> {
    const metadata = await browser.tabs.get(tabId);
    await this.client.sendResourceToServer({
      resource: "tab-metadata",
      correlationId,
      metadata: metadata as unknown as Record<string, unknown>,
    });
  }

  private async sendRecentHistory(
    correlationId: string,
    searchQuery: string | null = null
  ): Promise<void> {
    const historyItems = await browser.history.search({
      text: searchQuery ?? "", // Search for all URLs (empty string matches everything)
      maxResults: 200, // Limit to 200 results
      startTime: 0, // Search from the beginning of time
    });
    const filteredHistoryItems = historyItems.filter((item) => {
      return !!item.url;
    });
    await this.client.sendResourceToServer({
      resource: "history",
      correlationId,
      historyItems: filteredHistoryItems,
    });
  }

  // Check that the user has granted permission to access the URL's domain.
  // This will open the options page with a URL parameter to request permission
  // and throw an error to indicate that the request cannot proceed until permission is granted.
  private async checkForUrlPermission(url: string | undefined): Promise<void> {
    if (url) {
      const origin = new URL(url).origin;
      const granted = await browser.permissions.contains({
        origins: [`${origin}/*`],
      });

      if (!granted) {
        // Open the options page with a URL parameter to request permission:
        const optionsUrl = browser.runtime.getURL("options.html");
        const urlWithParams = `${optionsUrl}?requestUrl=${encodeURIComponent(
          url
        )}`;

        await browser.tabs.create({ url: urlWithParams });
        throw new Error(
          `The user has not yet granted permission to access the domain "${origin}". A dialog is now being opened to request permission. If the user grants permission, you can try the request again.`
        );
      }
    }
  }

  private async checkForGlobalPermission(permissions: string[]): Promise<void> {
    const granted = await browser.permissions.contains({
      permissions,
    });

    if (!granted) {
      // Open the options page with a URL parameter to request permission:
      const optionsUrl = browser.runtime.getURL("options.html");
      const urlWithParams = `${optionsUrl}?requestPermissions=${encodeURIComponent(
        JSON.stringify(permissions)
      )}`;

      await browser.tabs.create({ url: urlWithParams });
      throw new Error(
        `The user has not yet granted permission for the following operations: ${permissions.join(
          ", "
        )}. A dialog is now being opened to request permission. If the user grants permission, you can try the request again.`
      );
    }
  }

  private async sendTabsContent(
    correlationId: string,
    tabId: number,
    offset?: number,
    includeLinks = true,
    format: "text" | "markdown" = "text",
    scope: { mainContentOnly?: boolean; selector?: string; excludeSelector?: string } = {}
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }

    await this.checkForUrlPermission(tab.url);

    const results = await browser.tabs.executeScript(tabId, {
      code: `
      (function () {
        function getLinks() {
          const linkElements = document.querySelectorAll('a[href]');
          return Array.from(linkElements).map(el => ({
            url: el.href,
            text: el.innerText.trim() || el.getAttribute('aria-label') || el.getAttribute('title') || ''
          })).filter(link => link.text !== '' && link.url.startsWith('https://') && !link.url.includes('#'));
        }

        const scope = ${JSON.stringify({
          selector: scope.selector || null,
          exclude: scope.excludeSelector || null,
          mainContentOnly: scope.mainContentOnly === true,
        })};
        const root = scope.selector
          ? document.querySelector(scope.selector)
          : (scope.mainContentOnly && document.querySelector("main, article, [role=main]")) || document.body;
        if (!root) {
          return { missing: true };
        }
        const source = ${
          format === "markdown"
            ? `(${pageToMarkdown.toString()})(root, scope.exclude, ${includeLinks !== false})`
            : `(${visibleText.toString()})(root, scope.exclude)`
        };

        function getTextContent() {
          let isTruncated = false;
          let text = source.substring(${Number(offset) || 0});
          if (text.length > ${MAX_CONTENT_LENGTH}) {
            text = text.substring(0, ${MAX_CONTENT_LENGTH});
            isTruncated = true;
          }
          return {
            text, isTruncated
          }
        }

        const textContent = getTextContent();

        return {
          links: ${includeLinks ? "getLinks()" : "[]"},
          fullText: textContent.text,
          isTruncated: textContent.isTruncated,
          totalLength: source.length,
          format: ${JSON.stringify(format)},
          scoped: Boolean(scope.selector || scope.exclude)
        };
      })();
    `,
    });
    if (results[0]?.missing) {
      throw new Error(`No element matches the selector "${scope.selector}"`);
    }
    const { isTruncated, fullText, links, totalLength, scoped } = results[0];
    const message = this.truncateTabContentMessage({
      resource: "tab-content",
      tabId,
      correlationId,
      isTruncated,
      fullText,
      links,
      totalLength,
      format,
      ...(scoped ? { scoped } : {}),
    });
    await this.client.sendResourceToServer(message);
  }

  private truncateTabContentMessage(
    message: TabContentExtensionMessage
  ): TabContentExtensionMessage {
    const serializedLength = JSON.stringify(message).length;
    if (serializedLength <= MAX_TAB_CONTENT_RESPONSE_LENGTH) {
      return message;
    }

    const marker = `\n\n[FireMCP: truncated response; original serialized length was ${serializedLength} characters]`;
    const truncateFullText = (
      candidate: TabContentExtensionMessage
    ): TabContentExtensionMessage => {
      const overhead = JSON.stringify({ ...candidate, fullText: "" }).length;
      const maxTextLength = Math.max(
        0,
        MAX_TAB_CONTENT_RESPONSE_LENGTH - overhead - marker.length
      );
      return {
        ...candidate,
        fullText: `${message.fullText.substring(0, maxTextLength)}${marker}`,
      };
    };

    let truncated = truncateFullText({ ...message, isTruncated: true });
    if (JSON.stringify(truncated).length <= MAX_TAB_CONTENT_RESPONSE_LENGTH) {
      return truncated;
    }

    truncated = truncateFullText({ ...message, isTruncated: true, links: [] });
    if (JSON.stringify(truncated).length <= MAX_TAB_CONTENT_RESPONSE_LENGTH) {
      return truncated;
    }

    return {
      ...truncated,
      fullText: marker,
    };
  }

  private async reorderTabs(
    correlationId: string,
    tabOrder: number[]
  ): Promise<void> {
    // Reorder the tabs sequentially
    for (let newIndex = 0; newIndex < tabOrder.length; newIndex++) {
      const tabId = tabOrder[newIndex];
      await browser.tabs.move(tabId, { index: newIndex });
    }
    await this.client.sendResourceToServer({
      resource: "tabs-reordered",
      correlationId,
      tabOrder,
    });
  }

  private async findAndHighlightText(
    correlationId: string,
    tabId: number,
    queryPhrase: string
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);

    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }

    await this.checkForGlobalPermission(["find"]);

    const findResults = await browser.find.find(queryPhrase, {
      tabId,
      caseSensitive: true,
    });

    // If there are results, highlight them
    if (findResults.count > 0) {
      // But first, activate the tab. In firefox, this would also enable
      // auto-scrolling to the highlighted result.
      await browser.tabs.update(tabId, { active: true });
      browser.find.highlightResults({
        tabId,
      });
    }

    await this.client.sendResourceToServer({
      resource: "find-highlight-result",
      correlationId,
      noOfResults: findResults.count,
    });
  }

  // Deny list and per domain consent, as for reading the page text.
  private async assertPageAccess(tabId: number): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }
    await this.checkForUrlPermission(tab.url);
  }

  private async sendPageMeta(correlationId: string, tabId: number): Promise<void> {
    await this.assertPageAccess(tabId);
    const [meta] = await browser.tabs.executeScript(tabId, {
      code: `(${collectPageMeta.toString()})()`,
    });
    if (JSON.stringify(meta.jsonLd).length > MAX_JSON_LD_LENGTH) {
      meta.jsonLd = [{ truncated: `JSON-LD longer than ${MAX_JSON_LD_LENGTH} characters, omitted` }];
    }
    await this.client.sendResourceToServer({
      resource: "page-meta",
      correlationId,
      tabId,
      meta,
    });
  }

  private async sendSelection(correlationId: string, tabId: number): Promise<void> {
    await this.assertPageAccess(tabId);
    const [text] = await browser.tabs.executeScript(tabId, {
      code: `(${collectSelection.toString()})()`,
    });
    await this.client.sendResourceToServer({
      resource: "selection",
      correlationId,
      tabId,
      text: typeof text === "string" ? text : "",
    });
  }

  private async sendBookmarks(
    correlationId: string,
    query: string,
    limit: number = DEFAULT_BOOKMARK_LIMIT
  ): Promise<void> {
    await this.checkForGlobalPermission(["bookmarks"]);

    const folderPaths = new Map<string, string>();
    const folderPath = async (folderId: string | undefined): Promise<string> => {
      const names: string[] = [];
      let id = folderId;
      while (id) {
        const cached = folderPaths.get(id);
        if (cached !== undefined) {
          names.unshift(cached);
          break;
        }
        const [folder] = await browser.bookmarks.get(id);
        // The root has no parent and no useful title.
        if (!folder?.parentId) break;
        names.unshift(folder.title);
        id = folder.parentId;
      }
      const path = names.filter(Boolean).join(" / ");
      if (folderId) folderPaths.set(folderId, path);
      return path;
    };

    const items = [];
    for (const node of await browser.bookmarks.search(query)) {
      if (!node.url || (await isDomainInDenyList(node.url))) continue;
      items.push({
        title: node.title,
        url: node.url,
        folder: await folderPath(node.parentId),
        dateAdded: node.dateAdded,
      });
      if (items.length >= limit) break;
    }

    await this.client.sendResourceToServer({
      resource: "bookmarks",
      correlationId,
      items,
    });
  }

  // Lets the server tell this build from the stock add-on, which rejects the command.
  private async sendExtensionInfo(correlationId: string): Promise<void> {
    await this.client.sendResourceToServer({
      resource: "extension-info",
      correlationId,
      version: browser.runtime.getManifest().version,
      commands: Object.keys(COMMAND_TO_TOOL_ID),
    });
  }

  private async captureScreenshot(
    correlationId: string,
    tabId: number,
    format: "jpeg" | "png" = "jpeg",
    quality: number = 70,
    scale: number = 1
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);

    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }

    if (!hasCaptureConsent(tabId, tab.url)) {
      await markTabAsAwaitingConsent(tabId);
      throw new Error(
        `The user has not authorized screenshots of tab ${tabId} ("${
          tab.title ?? tab.url
        }"). The extension's toolbar button is now marked with a "!" badge on that tab. ` +
          `Ask the user to click the FireMCP button in the Firefox toolbar while that tab is open, then try again. ` +
          `The authorization covers only that tab, and ends when the tab navigates or closes.`
      );
    }

    if (tab.windowId === undefined) {
      throw new Error(`Tab ${tabId} does not belong to a window`);
    }

    // captureVisibleTab() captures whichever tab is active in the window, and activeTab is
    // only granted for the tab the user clicked, so the target tab has to be foregrounded
    // first. Restore the previous tab afterwards so the capture is not disruptive.
    const restoreTabId = tab.active
      ? undefined
      : await this.activateTabForCapture(tabId, tab.windowId);

    try {
      let dataUrl: string;
      try {
        dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, {
          format,
          quality,
          scale,
        });
      } catch (error) {
        // The browser is the real enforcer of the activeTab grant, so it can still refuse
        // even when the tracked consent looks valid.
        throw new Error(
          `Firefox refused to capture tab ${tabId}: ${
            error instanceof Error ? error.message : String(error)
          }. Capturing with per-tab authorization requires Firefox 126 or later. ` +
            `Otherwise, ask the user to click the extension's toolbar button on that tab again.`
        );
      }
      const { mimeType, imageData } = parseImageDataUrl(dataUrl);
      await this.client.sendResourceToServer({
        resource: "screenshot",
        correlationId,
        tabId,
        imageData,
        mimeType,
      });
    } finally {
      if (restoreTabId !== undefined) {
        try {
          await browser.tabs.update(restoreTabId, { active: true });
        } catch (error) {
          console.error("Failed to restore the previously active tab:", error);
        }
      }
    }
  }

  // Foregrounds the tab to be captured, returning the tab that was active before, if any.
  private async activateTabForCapture(
    tabId: number,
    windowId: number
  ): Promise<number | undefined> {
    const [previouslyActive] = await browser.tabs.query({
      active: true,
      windowId,
    });
    await browser.tabs.update(tabId, { active: true });
    await new Promise((resolve) => setTimeout(resolve, TAB_PAINT_DELAY_MS));
    return previouslyActive?.id;
  }

  private async groupTabs(
    correlationId: string,
    tabIds: number[],
    isCollapsed: boolean,
    groupColor: browser.tabGroups.Color,
    groupTitle: string
  ): Promise<void> {
    const groupId = await browser.tabs.group({
      tabIds,
    });

    let tabGroup = await browser.tabGroups.update(groupId, {
      collapsed: isCollapsed,
      color: groupColor,
      title: groupTitle,
    });

    await this.client.sendResourceToServer({
      resource: "new-tab-group",
      correlationId,
      groupId: tabGroup.id,
    });
  }
}

function parseImageDataUrl(dataUrl: string): {
  mimeType: string;
  imageData: string;
} {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) {
    throw new Error("The browser returned a screenshot in an unexpected format");
  }
  return { mimeType: match[1], imageData: match[2] };
}
