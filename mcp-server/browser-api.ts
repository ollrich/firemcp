import WebSocket from "ws";
import type {
  ExtensionMessage,
  BrowserTab,
  BrowserHistoryItem,
  ServerMessage,
  TabContentExtensionMessage,
  ScreenshotExtensionMessage,
  PageMeta,
  BookmarkItem,
  ServerMessageRequest,
  ExtensionError,
} from "@browser-control-mcp/common";
import { isPortInUse } from "./util";
import * as crypto from "crypto";
import type { BrowserApiOperation } from "./browser-operations";
import { pickActiveTab } from "./content-utils";
import {
  BROKER_PROTOCOL_VERSION,
  type BrokerIdentity,
  type BrokerInfo,
  clearBrokerInfo,
  createBrokerIdentity,
  createBrokerServer,
  createBrokerToken,
  forwardToBroker,
  getBrokerSocketPath,
  pingBroker,
  readBrokerInfo,
  writeBrokerInfo,
} from "./singleton-broker";

export { BROWSER_API_OPERATIONS, isBrowserApiOperation } from "./browser-operations";

const WS_DEFAULT_PORT = 8089;
const EXTENSION_RESPONSE_TIMEOUT_MS = 5000;
// Capturing may foreground the tab, wait for it to paint, encode the image and transfer a
// payload orders of magnitude larger than the other responses.
const SCREENSHOT_RESPONSE_TIMEOUT_MS = 10_000;
const WS_OPEN_WAIT_TIMEOUT_MS = 10_000;
const WS_OPEN_POLL_INTERVAL_MS = 100;
const BROKER_REQUEST_TIMEOUT_MS = 15_000;

// Set BROWSER_MCP_DEBUG=1 (or =true) to enable verbose trace logging
const DEBUG = ["1", "true"].includes(
  (process.env.BROWSER_MCP_DEBUG ?? "").toLowerCase()
);

function trace(...args: unknown[]) {
  if (DEBUG) {
    console.error("[browser-mcp:trace]", new Date().toISOString(), ...args);
  }
}

// Loopback only, on IPv4 and IPv6, so Firefox connects whichever way localhost resolves.
export function getWebSocketHosts(): string[] {
  return ["127.0.0.1", "::1"];
}

export function buildPortInUseMessage(port: number): string {
  return (
    `firemcp: port ${port} is already in use, likely by another MCP client session. ` +
    "No live broker responded for this EXTENSION_PORT and EXTENSION_SECRET, so forwarding could not start. " +
    "If this is a different browser, configure it with a different EXTENSION_PORT and EXTENSION_SECRET."
  );
}

// Optional get-tab-content fields of the FireMCP add-on; the original add-on ignores them.
export interface ContentOptions {
  includeLinks?: boolean;
  format?: "text" | "markdown";
  mainContentOnly?: boolean;
  selector?: string;
  excludeSelector?: string;
}

export interface ExtensionInfo {
  version: string;
  commands: string[];
}

interface ExtensionRequestResolver<T extends ExtensionMessage["resource"]> {
  resource: T;
  resolve: (value: Extract<ExtensionMessage, { resource: T }>) => void;
  reject: (reason?: string) => void;
}

export class BrowserAPI {
  private ws: WebSocket | null = null;
  private extensionSockets: Set<WebSocket> = new Set();
  private wsServers: WebSocket.Server[] = [];
  private sharedSecret: string | null = null;
  private unavailableReason: string | null = null;
  private brokerIdentity: BrokerIdentity | null = null;
  private brokerInfo: BrokerInfo | null = null;
  private brokerServer: ReturnType<typeof createBrokerServer> | null = null;
  private selectedPort: number | null = null;
  private recovery: Promise<void> | null = null;
  // Handshake result per extension connection; null means the stock add-on.
  private extensionInfoCache: { socket: WebSocket | null; info: ExtensionInfo | null } | null = null;

  // Map to persist the request to the extension. It maps the request correlationId
  // to a resolver, fulfulling a promise created when sending a message to the extension.
  private extensionRequestMap: Map<
    string,
    ExtensionRequestResolver<ExtensionMessage["resource"]>
  > = new Map();

  async init() {
    const { secret, port } = readConfig();
    if (!secret) {
      throw new Error(
        "EXTENSION_SECRET env var missing. See the extension's options page."
      );
    }
    this.sharedSecret = secret;
    this.brokerIdentity = createBrokerIdentity({ port, extensionSecret: secret });
    this.selectedPort = port;

    await this.connectOrLead();
  }

  async close(): Promise<void> {
    if (this.brokerInfo?.pid === process.pid) {
      clearBrokerInfo(this.brokerInfo);
    }

    await Promise.all([...this.extensionSockets].map((socket) => new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      socket.once("close", () => resolve());
      socket.close(1001, "firemcp broker shutting down");
    })));
    this.extensionSockets.clear();
    this.ws = null;

    try {
      await this.brokerServer?.close();
    } catch (error) {
      console.error("Failed to close the firemcp broker", error);
    }
    this.brokerServer = null;

    await Promise.all(this.wsServers.map((wsServer) => new Promise<void>((resolve) => {
      wsServer.close(() => resolve());
    })));
    this.wsServers = [];
  }

  getSelectedPort() {
    return this.wsServers[0]?.options.port ?? this.selectedPort ?? undefined;
  }

  async openTab(url: string, active?: boolean): Promise<number | undefined> {
    return this.run("openTab", [url, active], async () => {
      const correlationId = await this.sendMessageToExtension({
        cmd: "open-tab",
        url,
        ...(active === undefined ? {} : { active }),
      });
      const message = await this.waitForResponse(correlationId, "opened-tab-id");
      return message.tabId;
    });
  }

  async closeTabs(tabIds: number[]): Promise<void> {
    await this.run("closeTabs", [tabIds], async () => {
      const correlationId = await this.sendMessageToExtension({
        cmd: "close-tabs",
        tabIds,
      });
      await this.waitForResponse(correlationId, "tabs-closed");
    });
  }

  async getTabList(): Promise<BrowserTab[]> {
    return this.run("getTabList", [], async () => {
      const correlationId = await this.sendMessageToExtension({
        cmd: "get-tab-list",
      });
      const message = await this.waitForResponse(correlationId, "tabs");
      return message.tabs;
    });
  }

  // Served from the tab list (Firefox sends full tabs.Tab objects), so it also works
  // with extension builds that lack the get-current-tab command. The stock add-on
  // rejects unknown commands as "disabled in extension settings".
  async getCurrentTab(): Promise<BrowserTab> {
    const tab = pickActiveTab(await this.getTabList());
    if (!tab) {
      throw new Error("No open tab found");
    }
    return tab;
  }

  // Same approach as getCurrentTab: tabs.query returns the same object as tabs.get.
  async getTabMetadata(tabId: number): Promise<Record<string, unknown>> {
    const tab = (await this.getTabList()).find((t) => t.id === tabId);
    if (!tab) {
      throw new Error(`No open tab with id ${tabId}`);
    }
    return tab as Record<string, unknown>;
  }

  async getBrowserRecentHistory(
    searchQuery?: string
  ): Promise<BrowserHistoryItem[]> {
    return this.run("getBrowserRecentHistory", [searchQuery], async () => {
      const correlationId = await this.sendMessageToExtension({
        cmd: "get-browser-recent-history",
        searchQuery,
      });
      const message = await this.waitForResponse(correlationId, "history");
      return message.historyItems;
    });
  }

  async getTabContent(
    tabId: number,
    offset: number,
    options: ContentOptions = {}
  ): Promise<TabContentExtensionMessage> {
    return this.run("getTabContent", [tabId, offset, options], async () => {
      const correlationId = await this.sendMessageToExtension({
        cmd: "get-tab-content",
        tabId,
        offset,
        ...options,
      });
      return await this.waitForResponse(correlationId, "tab-content");
    });
  }

  async reorderTabs(tabOrder: number[]): Promise<number[]> {
    return this.run("reorderTabs", [tabOrder], async () => {
      const correlationId = await this.sendMessageToExtension({
        cmd: "reorder-tabs",
        tabOrder,
      });
      const message = await this.waitForResponse(correlationId, "tabs-reordered");
      return message.tabOrder;
    });
  }

  async findHighlight(tabId: number, queryPhrase: string): Promise<number> {
    return this.run("findHighlight", [tabId, queryPhrase], async () => {
      const correlationId = await this.sendMessageToExtension({
        cmd: "find-highlight",
        tabId,
        queryPhrase,
      });
      const message = await this.waitForResponse(
        correlationId,
        "find-highlight-result"
      );
      return message.noOfResults;
    });
  }

  async groupTabs(
    tabIds: number[],
    isCollapsed: boolean,
    groupColor: string,
    groupTitle: string
  ): Promise<number> {
    return this.run("groupTabs", [tabIds, isCollapsed, groupColor, groupTitle], async () => {
      const correlationId = await this.sendMessageToExtension({
        cmd: "group-tabs",
        tabIds,
        isCollapsed,
        groupColor,
        groupTitle,
      });
      const message = await this.waitForResponse(correlationId, "new-tab-group");
      return message.groupId;
    });
  }

  async captureScreenshot(
    tabId: number,
    format: "jpeg" | "png",
    quality: number,
    scale: number
  ): Promise<ScreenshotExtensionMessage> {
    return this.run("captureScreenshot", [tabId, format, quality, scale], async () => {
      const correlationId = await this.sendMessageToExtension({
        cmd: "capture-screenshot",
        tabId,
        format,
        quality,
        scale,
      });
      return await this.waitForResponse(
        correlationId,
        "screenshot",
        SCREENSHOT_RESPONSE_TIMEOUT_MS
      );
    });
  }

  // Version and commands of the connected extension, or null for the stock
  // add-on, which rejects the handshake like any unknown command.
  async getExtensionInfo(): Promise<ExtensionInfo | null> {
    return this.run("getExtensionInfo", [], async () => {
      if (this.extensionInfoCache && this.extensionInfoCache.socket === this.ws) {
        return this.extensionInfoCache.info;
      }
      let info: ExtensionInfo | null = null;
      try {
        const correlationId = await this.sendMessageToExtension({ cmd: "get-extension-info" });
        const message = await this.waitForResponse(correlationId, "extension-info");
        info = { version: message.version, commands: message.commands };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (!/disabled in extension settings|Timed out/i.test(reason)) {
          throw error;
        }
      }
      this.extensionInfoCache = { socket: this.ws, info };
      return info;
    });
  }

  async getPageMeta(tabId: number): Promise<PageMeta> {
    return this.run("getPageMeta", [tabId], async () => {
      const correlationId = await this.sendMessageToExtension({ cmd: "get-page-meta", tabId });
      return (await this.waitForResponse(correlationId, "page-meta")).meta;
    });
  }

  async getSelection(tabId: number): Promise<string> {
    return this.run("getSelection", [tabId], async () => {
      const correlationId = await this.sendMessageToExtension({ cmd: "get-selection", tabId });
      return (await this.waitForResponse(correlationId, "selection")).text;
    });
  }

  async searchBookmarks(query: string, limit: number): Promise<BookmarkItem[]> {
    return this.run("searchBookmarks", [query, limit], async () => {
      const correlationId = await this.sendMessageToExtension({ cmd: "search-bookmarks", query, limit });
      return (await this.waitForResponse(correlationId, "bookmarks")).items;
    });
  }

  // Routes an operation: retry setup if this session could not start, forward to
  // the broker when another session owns the browser port, else talk directly.
  private async run<T>(
    operation: BrowserApiOperation,
    args: unknown[],
    direct: () => Promise<T>
  ): Promise<T> {
    if (this.unavailableReason) {
      await this.recover();
    }
    if (this.isForwarding()) {
      return await this.forwardOperation(operation, args) as T;
    }
    return await direct();
  }

  private isForwarding(): boolean {
    return Boolean(this.brokerInfo && this.brokerInfo.pid !== process.pid);
  }

  private async forwardOperation(operation: BrowserApiOperation, args: unknown[]): Promise<unknown> {
    try {
      return await this.forwardToCurrentBroker(operation, args);
    } catch (error) {
      trace("Cached broker request failed; attempting broker recovery", {
        operation,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.recover();
      if (this.isForwarding()) {
        return await this.forwardToCurrentBroker(operation, args);
      }
      return await this.dispatchOperation(operation, args);
    }
  }

  private async forwardToCurrentBroker(operation: BrowserApiOperation, args: unknown[]): Promise<unknown> {
    if (!this.brokerInfo) {
      throw new Error("Browser broker forwarding is not initialized");
    }

    return await forwardToBroker({
      socketPath: this.brokerInfo.socketPath,
      token: this.brokerInfo.token,
      operation,
      args,
      timeoutMs: BROKER_REQUEST_TIMEOUT_MS,
    });
  }

  // Single flight, so concurrent tool calls do not race to become leader.
  private recover(): Promise<void> {
    if (!this.recovery) {
      this.recovery = this.connectOrLead().finally(() => {
        this.recovery = null;
      });
    }
    return this.recovery;
  }

  // Forward to the live broker when the browser port is taken, become the leader
  // when it is free. Otherwise record why this session cannot reach the browser;
  // the next tool call tries again.
  private async connectOrLead(): Promise<void> {
    if (!this.brokerIdentity || !this.selectedPort) {
      throw new Error("Browser broker identity is not initialized");
    }
    const identity = this.brokerIdentity;
    const port = this.selectedPort;

    if (await isPortInUse(port)) {
      const brokerInfo = readBrokerInfo(identity);
      if (
        brokerInfo &&
        await pingBroker({
          socketPath: brokerInfo.socketPath,
          token: brokerInfo.token,
          timeoutMs: 1000,
        })
      ) {
        this.brokerInfo = brokerInfo;
        this.unavailableReason = null;
        console.error(
          `firemcp: forwarding browser tools for ${identity.id} to broker process ${brokerInfo.pid}`
        );
        return;
      }

      this.brokerInfo = null;
      this.unavailableReason = buildPortInUseMessage(port);
      console.error(this.unavailableReason);
      return;
    }

    this.brokerInfo = null;
    this.unavailableReason = null;
    await this.becomeLeader(identity, port);
  }

  private async becomeLeader(identity: BrokerIdentity, port: number): Promise<void> {
    for (const host of getWebSocketHosts()) {
      const wsServer = new WebSocket.Server({
        host,
        port,
      });

      console.error(`Starting WebSocket server on ${host}:${port}`);
      trace("WebSocket server binding", { host, port, debug: true });

      wsServer.on("connection", async (connection, req) => {
        const prevState = this.ws ? this.ws.readyState : "none";
        this.ws = connection;
        this.extensionSockets.add(connection);

        console.error("WebSocket connection established on port", port);
        trace("Extension connected", {
          remoteAddress: req.socket.remoteAddress,
          previousSocketState: prevState,
          pendingRequests: this.extensionRequestMap.size,
        });

        this.ws.on("message", (message) => {
          let decoded: any;
          try {
            decoded = JSON.parse(message.toString());
          } catch (parseErr) {
            console.error("Failed to parse extension message:", parseErr);
            trace("Message parse failure", {
              rawLength: message.toString().length,
              error: String(parseErr),
            });
            return;
          }

          if (isErrorMessage(decoded)) {
            trace("Received extension error", {
              correlationId: decoded.correlationId,
              errorMessage: decoded.errorMessage,
            });
            this.handleExtensionError(decoded);
            return;
          }
          const signature = this.createSignature(JSON.stringify(decoded.payload));
          if (signature !== decoded.signature) {
            console.error("Invalid message signature");
            trace("Signature mismatch", {
              correlationId: decoded.payload?.correlationId,
              resource: decoded.payload?.resource,
            });
            return;
          }
          trace("Received valid extension message", {
            correlationId: decoded.payload.correlationId,
            resource: decoded.payload.resource,
          });
          this.handleDecodedExtensionMessage(decoded.payload);
        });

        this.ws.on("close", (code, reason) => {
          this.extensionSockets.delete(connection);
          if (this.ws === connection) {
            this.ws = null;
          }
          console.error("WebSocket connection closed", { code, reason: reason.toString() });
          trace("Extension socket closed", {
            code,
            reason: reason.toString(),
            pendingRequests: this.extensionRequestMap.size,
            pendingCorrelationIds: [...this.extensionRequestMap.keys()],
          });
        });

        this.ws.on("error", (error) => {
          console.error("WebSocket connection error:", error.message);
          trace("Extension socket error", { error: error.message, stack: error.stack });
        });
      });
      wsServer.on("error", (error) => {
        console.error(`WebSocket server error on ${host}:${port}:`, error);
        trace("Server-level WS error", { host, port, error: String(error) });
      });

      this.wsServers.push(wsServer);
    }

    const token = createBrokerToken();
    const socketPath = getBrokerSocketPath(identity);
    const info: BrokerInfo = {
      pid: process.pid,
      identity,
      socketPath,
      token,
      protocolVersion: BROKER_PROTOCOL_VERSION,
      startedAt: Date.now(),
    };

    const brokerServer = createBrokerServer({
      socketPath,
      token,
      handleOperation: (operation, args) => this.dispatchOperation(operation, args),
    });
    try {
      await brokerServer.start();
    } catch (error) {
      // The extension connection works without the broker; only other sessions
      // lose the ability to forward to this one.
      console.error(
        `firemcp: could not start the session broker at ${socketPath}; ` +
          "other MCP sessions cannot share this browser connection.",
        error
      );
      return;
    }
    this.brokerServer = brokerServer;
    writeBrokerInfo(info);
    this.brokerInfo = info;
  }

  private async dispatchOperation(operation: BrowserApiOperation, args: unknown[]): Promise<unknown> {
    switch (operation) {
      case "openTab":
        return await this.openTab(args[0] as string, args[1] as boolean | undefined);
      case "closeTabs":
        return await this.closeTabs(args[0] as number[]);
      case "getTabList":
        return await this.getTabList();
      case "getCurrentTab":
        return await this.getCurrentTab();
      case "getTabMetadata":
        return await this.getTabMetadata(args[0] as number);
      case "getBrowserRecentHistory":
        return await this.getBrowserRecentHistory(args[0] as string | undefined);
      case "getTabContent":
        // Sessions of the previous release forwarded a bare includeLinks flag.
        return await this.getTabContent(
          args[0] as number,
          args[1] as number,
          typeof args[2] === "boolean" ? { includeLinks: args[2] } : (args[2] as ContentOptions | undefined)
        );
      case "reorderTabs":
        return await this.reorderTabs(args[0] as number[]);
      case "findHighlight":
        return await this.findHighlight(args[0] as number, args[1] as string);
      case "groupTabs":
        return await this.groupTabs(
          args[0] as number[],
          args[1] as boolean,
          args[2] as string,
          args[3] as string
        );
      case "getExtensionInfo":
        return await this.getExtensionInfo();
      case "getPageMeta":
        return await this.getPageMeta(args[0] as number);
      case "getSelection":
        return await this.getSelection(args[0] as number);
      case "searchBookmarks":
        return await this.searchBookmarks(args[0] as string, args[1] as number);
      case "captureScreenshot":
        return await this.captureScreenshot(
          args[0] as number,
          args[1] as "jpeg" | "png",
          args[2] as number,
          args[3] as number
        );
      default: {
        const exhaustiveCheck: never = operation;
        throw new Error(`Unsupported browser operation: ${exhaustiveCheck}`);
      }
    }
  }

  private createSignature(payload: string): string {
    if (!this.sharedSecret) {
      throw new Error("Shared secret not initialized");
    }
    const hmac = crypto.createHmac("sha256", this.sharedSecret);
    hmac.update(payload);
    return hmac.digest("hex");
  }

  private async sendMessageToExtension(message: ServerMessage): Promise<string> {
    trace("Preparing to send message to extension", {
      cmd: message.cmd,
      wsState: this.ws?.readyState ?? "null",
    });

    await this.waitForWebSocketOpen();

    const correlationId = crypto.randomUUID();
    const req: ServerMessageRequest = { ...message, correlationId };
    const payload = JSON.stringify(req);
    const signature = this.createSignature(payload);
    const signedMessage = {
      payload: req,
      signature: signature,
    };

    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      trace("WebSocket closed before send", {
        cmd: message.cmd,
        correlationId,
        wsState: ws?.readyState ?? "null",
      });
      throw new Error("WebSocket was closed before sending the message");
    }

    // Send the signed message to the extension
    ws.send(JSON.stringify(signedMessage));
    trace("Sent message to extension", { cmd: message.cmd, correlationId });

    return correlationId;
  }

  private async waitForWebSocketOpen(): Promise<void> {
    if (this.unavailableReason) {
      throw new Error(this.unavailableReason);
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    trace("Waiting for WebSocket to open", {
      wsExists: !!this.ws,
      wsState: this.ws?.readyState ?? "null",
      timeoutMs: WS_OPEN_WAIT_TIMEOUT_MS,
    });

    const deadline = Date.now() + WS_OPEN_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        trace("WebSocket became open after waiting");
        return;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, WS_OPEN_POLL_INTERVAL_MS);
      });
    }

    const port = this.getSelectedPort() ?? process.env.EXTENSION_PORT ?? WS_DEFAULT_PORT;
    trace("WebSocket open timeout reached", {
      wsExists: !!this.ws,
      wsState: this.ws?.readyState ?? "null",
      port,
    });
    throw new Error(
      `WebSocket is not open after ${WS_OPEN_WAIT_TIMEOUT_MS}ms. ` +
        `Make sure the Firefox extension is installed, running, and configured to use port ${port}.`
    );
  }

  private handleDecodedExtensionMessage(decoded: ExtensionMessage) {
    const { correlationId } = decoded;
    const entry = this.extensionRequestMap.get(correlationId);
    if (!entry) {
      // Response arrived after timeout or for an unknown correlationId -- safe to ignore
      console.error("Received response for unknown/expired correlationId:", correlationId);
      trace("Orphaned extension response (likely timed out)", {
        correlationId,
        resource: decoded.resource,
        pendingKeys: [...this.extensionRequestMap.keys()],
      });
      return;
    }
    const { resolve, resource } = entry;
    if (resource !== decoded.resource) {
      console.error("Resource mismatch:", resource, decoded.resource);
      trace("Resource mismatch detail", { correlationId, expected: resource, actual: decoded.resource });
      return;
    }
    this.extensionRequestMap.delete(correlationId);
    trace("Resolved extension response", { correlationId, resource });
    resolve(decoded);
  }

  private handleExtensionError(decoded: ExtensionError) {
    const { correlationId, errorMessage } = decoded;
    const entry = this.extensionRequestMap.get(correlationId);
    if (!entry) {
      console.error("Received error for unknown/expired correlationId:", correlationId, errorMessage);
      trace("Orphaned extension error (likely timed out)", {
        correlationId,
        errorMessage,
        pendingKeys: [...this.extensionRequestMap.keys()],
      });
      return;
    }
    const { reject } = entry;
    this.extensionRequestMap.delete(correlationId);
    trace("Rejecting with extension error", { correlationId, errorMessage });
    reject(errorMessage);
  }

  private async waitForResponse<T extends ExtensionMessage["resource"]>(
    correlationId: string,
    resource: T,
    timeoutMs: number = EXTENSION_RESPONSE_TIMEOUT_MS
  ): Promise<Extract<ExtensionMessage, { resource: T }>> {
    return new Promise<Extract<ExtensionMessage, { resource: T }>>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          if (this.extensionRequestMap.has(correlationId)) {
            this.extensionRequestMap.delete(correlationId);
            trace("Response timeout", {
              correlationId,
              resource,
              timeoutMs,
              wsState: this.ws?.readyState ?? "null",
            });
            reject(
              `Timed out waiting for response (resource=${resource}, ` +
                `timeout=${timeoutMs}ms, correlationId=${correlationId})`
            );
          }
        }, timeoutMs);
        this.extensionRequestMap.set(correlationId, {
          resolve: ((value: ExtensionMessage) => {
            clearTimeout(timeout);
            resolve(value as Extract<ExtensionMessage, { resource: T }>);
          }) as (value: ExtensionMessage) => void,
          resource,
          reject: (reason?: string) => {
            clearTimeout(timeout);
            reject(reason);
          },
        });
      }
    );
  }
}

function readConfig() {
  return {
    secret: process.env.EXTENSION_SECRET,
    port: process.env.EXTENSION_PORT
      ? parseInt(process.env.EXTENSION_PORT, 10)
      : WS_DEFAULT_PORT,
  };
}

export function isErrorMessage(message: any): message is ExtensionError {
  return (
    message.errorMessage !== undefined && message.correlationId !== undefined
  );
}
