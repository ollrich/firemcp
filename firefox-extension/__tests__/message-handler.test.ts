import { MessageHandler } from "../message-handler";
import { WebsocketClient } from "../client";
import type { ServerMessageRequest, TabContentExtensionMessage } from "@browser-control-mcp/common";
import { ExtensionConfig } from "../extension-config";
import { grantCaptureConsent, revokeCaptureConsent } from "../capture-consent";

// Mock the WebsocketClient
jest.mock("../client", () => {
  return {
    WebsocketClient: jest.fn().mockImplementation(() => {
      return {
        sendResourceToServer: jest.fn().mockResolvedValue(undefined),
        sendErrorToServer: jest.fn().mockResolvedValue(undefined),
      };
    }),
  };
});

describe("MessageHandler", () => {
  let messageHandler: MessageHandler;
  let mockClient: jest.Mocked<WebsocketClient>;

  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();

    // Create a new instance of WebsocketClient and MessageHandler
    mockClient = new WebsocketClient(
      8080,
      "test-secret"
    ) as jest.Mocked<WebsocketClient>;
    messageHandler = new MessageHandler(mockClient);

    // Mock browser.storage.local.get to return default config
    const defaultConfig: ExtensionConfig = {
      secret: "test-secret",
      toolSettings: {
        "open-browser-tab": true,
        "close-browser-tabs": true,
        "get-list-of-open-tabs": true,
        "get-tab-metadata": true,
        "get-recent-browser-history": true,
        "get-tab-web-content": true,
        "reorder-browser-tabs": true,
        "find-highlight-in-browser-tab": true,
        "get-current-tab": true,
      },
      domainDenyList: [],
      ports: [8089],
      auditLog: [],
    };

    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: defaultConfig,
    });
  });

  describe("handleDecodedMessage", () => {
    it("should throw an error if command is not allowed", async () => {
      // Arrange
      const configWithDisabledOpenTab: ExtensionConfig = {
        secret: "test-secret",
        toolSettings: {
          "open-browser-tab": false, // Disable open-tab command
          "close-browser-tabs": true,
          "get-list-of-open-tabs": true,
          "get-recent-browser-history": true,
          "get-tab-web-content": true,
          "reorder-browser-tabs": true,
          "find-highlight-in-browser-tab": true,
        },
        domainDenyList: [],
        ports: [8089],
        auditLog: [],
      };
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: configWithDisabledOpenTab,
      });

      const request: ServerMessageRequest = {
        cmd: "open-tab",
        url: "https://example.com",
        correlationId: "test-correlation-id",
      };

      // Act & Assert
      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("Command 'open-tab' is disabled in extension settings");
    });

    describe("open-tab command", () => {
      it("should open a new tab and send the tab ID to the server", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "open-tab",
          url: "https://example.com",
          correlationId: "test-correlation-id",
        };

        const mockTab = { id: 123 };
        (browser.tabs.create as jest.Mock).mockResolvedValue(mockTab);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.create).toHaveBeenCalledWith({
          url: "https://example.com",
          active: true,
        });
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "opened-tab-id",
          correlationId: "test-correlation-id",
          tabId: 123,
        });
      });

      it("should throw an error if URL does not start with https://", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "open-tab",
          url: "http://example.com",
          correlationId: "test-correlation-id",
        };

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow("Invalid URL");
        expect(browser.tabs.create).not.toHaveBeenCalled();
      });

      it("should throw an error if domain is in deny list", async () => {
        // Arrange
        const configWithDenyList: ExtensionConfig = {
          secret: "test-secret",
          toolSettings: {
            "open-browser-tab": true,
            "close-browser-tabs": true,
            "get-list-of-open-tabs": true,
            "get-recent-browser-history": true,
            "get-tab-web-content": true,
            "reorder-browser-tabs": true,
            "find-highlight-in-browser-tab": true,
          },
          domainDenyList: ["example.com", "another.com"],
          ports: [8089],
          auditLog: [],
        };
        (browser.storage.local.get as jest.Mock).mockResolvedValue({
          config: configWithDenyList,
        });

        const request: ServerMessageRequest = {
          cmd: "open-tab",
          url: "https://example.com",
          correlationId: "test-correlation-id",
        };

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow("Domain in user defined deny list");
        expect(browser.tabs.create).not.toHaveBeenCalled();
      });

      it("should open a new tab in the domain is not in the deny list", async () => {
        // Arrange
        const configWithDenyList: ExtensionConfig = {
          secret: "test-secret",
          toolSettings: {
            "open-browser-tab": true,
            "close-browser-tabs": true,
            "get-list-of-open-tabs": true,
            "get-recent-browser-history": true,
            "get-tab-web-content": true,
            "reorder-browser-tabs": true,
            "find-highlight-in-browser-tab": true,
          },
          domainDenyList: ["example.com", "another.com"],
          ports: [8089],
          auditLog: [],
        };
        (browser.storage.local.get as jest.Mock).mockResolvedValue({
          config: configWithDenyList,
        });

        const request: ServerMessageRequest = {
          cmd: "open-tab",
          url: "https://allowed.com",
          correlationId: "test-correlation-id",
        };

        const mockTab = { id: 123 };
        (browser.tabs.create as jest.Mock).mockResolvedValue(mockTab);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.create).toHaveBeenCalledWith({
          url: "https://allowed.com",
          active: true,
        });
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "opened-tab-id",
          correlationId: "test-correlation-id",
          tabId: 123,
        });
      });
    });

    describe("close-tabs command", () => {
      it("should close tabs and send confirmation to the server", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "close-tabs",
          tabIds: [123, 456],
          correlationId: "test-correlation-id",
        };

        (browser.tabs.remove as jest.Mock).mockResolvedValue(undefined);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.remove).toHaveBeenCalledWith([123, 456]);
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "tabs-closed",
          correlationId: "test-correlation-id",
        });
      });
    });

    describe("get-tab-list command", () => {
      it("should get tabs and send them to the server", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "get-tab-list",
          correlationId: "test-correlation-id",
        };

        const mockTabs = [{ id: 123, url: "https://example.com" }];
        (browser.tabs.query as jest.Mock).mockResolvedValue(mockTabs);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.query).toHaveBeenCalledWith({});
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "tabs",
          correlationId: "test-correlation-id",
          tabs: mockTabs,
        });
      });
    });

    describe("get-current-tab command", () => {
      it("should get the active tab in the current window and send it to the server", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "get-current-tab",
          correlationId: "test-correlation-id",
        };

        const mockTab = { id: 123, url: "https://example.com", title: "Example" };
        (browser.tabs.query as jest.Mock).mockResolvedValue([mockTab]);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.query).toHaveBeenCalledWith({
          active: true,
          currentWindow: true,
        });
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "current-tab",
          correlationId: "test-correlation-id",
          tab: mockTab,
        });
      });
    });

    describe("get-tab-metadata command", () => {
      it("should get tab metadata and send it to the server", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "get-tab-metadata",
          tabId: 123,
          correlationId: "test-correlation-id",
        };

        const mockTabMetadata = {
          id: 123,
          url: "https://example.com",
          title: "Example Page",
          active: true,
          pinned: false,
          windowId: 1,
        };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTabMetadata);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.get).toHaveBeenCalledWith(123);
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "tab-metadata",
          correlationId: "test-correlation-id",
          metadata: mockTabMetadata,
        });
      });
    });

    describe("get-browser-recent-history command", () => {
      it("should get history items and send them to the server", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "get-browser-recent-history",
          searchQuery: "test",
          correlationId: "test-correlation-id",
        };

        const mockHistoryItems = [
          { url: "https://example.com", title: "Example" },
          { url: "https://test.com", title: "Test" },
        ];
        (browser.history.search as jest.Mock).mockResolvedValue(
          mockHistoryItems
        );

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.history.search).toHaveBeenCalledWith({
          text: "test",
          maxResults: 200,
          startTime: 0,
        });
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "history",
          correlationId: "test-correlation-id",
          historyItems: mockHistoryItems,
        });
      });

      it("should use empty string for search query if not provided", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "get-browser-recent-history",
          correlationId: "test-correlation-id",
        };

        const mockHistoryItems = [
          { url: "https://example.com", title: "Example" },
        ];
        (browser.history.search as jest.Mock).mockResolvedValue(
          mockHistoryItems
        );

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.history.search).toHaveBeenCalledWith({
          text: "",
          maxResults: 200,
          startTime: 0,
        });
      });

      it("should filter out history items without URLs", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "get-browser-recent-history",
          correlationId: "test-correlation-id",
        };

        const mockHistoryItems = [
          { url: "https://example.com", title: "Example" },
          { title: "No URL" }, // This should be filtered out
        ];
        (browser.history.search as jest.Mock).mockResolvedValue(
          mockHistoryItems
        );

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "history",
          correlationId: "test-correlation-id",
          historyItems: [{ url: "https://example.com", title: "Example" }],
        });
      });
    });

    describe("get-tab-content command", () => {
      it("should get tab content and send it to the server", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "get-tab-content",
          tabId: 123,
          correlationId: "test-correlation-id",
        };

        const mockTab = { id: 123, url: "https://example.com" };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);
        (browser.permissions.contains as jest.Mock).mockResolvedValue(true);

        const mockScriptResult = [
          {
            links: [{ url: "https://example.com/page", text: "Page" }],
            fullText: "Page content",
            isTruncated: false,
            totalLength: 12,
          },
        ];
        (browser.tabs.executeScript as jest.Mock).mockResolvedValue(
          mockScriptResult
        );

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.get).toHaveBeenCalledWith(123);
        expect(browser.permissions.contains).toHaveBeenCalledWith({
          origins: ["https://example.com/*"],
        });
        expect(browser.tabs.executeScript).toHaveBeenCalled();
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "tab-content",
          tabId: 123,
          correlationId: "test-correlation-id",
          isTruncated: false,
          fullText: "Page content",
          links: [{ url: "https://example.com/page", text: "Page" }],
          totalLength: 12,
          format: "text",
        });
      });

      it("should throw an error if tab URL domain is in deny list", async () => {
        // Arrange
        const configWithDenyList: ExtensionConfig = {
          secret: "test-secret",
          toolSettings: {
            "open-browser-tab": true,
            "close-browser-tabs": true,
            "get-list-of-open-tabs": true,
            "get-recent-browser-history": true,
            "get-tab-web-content": true,
            "reorder-browser-tabs": true,
            "find-highlight-in-browser-tab": true,
          },
          domainDenyList: ["example.com"], // Add example.com to deny list
          ports: [8089],
          auditLog: [],
        };
        (browser.storage.local.get as jest.Mock).mockResolvedValue({
          config: configWithDenyList,
        });

        const request: ServerMessageRequest = {
          cmd: "get-tab-content",
          tabId: 123,
          correlationId: "test-correlation-id",
        };

        const mockTab = { id: 123, url: "https://example.com" };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow("Domain in tab URL is in the deny list");
        expect(browser.tabs.executeScript).not.toHaveBeenCalled();
      });

      it("should throw an error if permissions are denied", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "get-tab-content",
          tabId: 123,
          correlationId: "test-correlation-id",
        };

        const mockTab = { id: 123, url: "https://example.com" };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);
        (browser.permissions.contains as jest.Mock).mockResolvedValue(false);

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow();
        expect(browser.tabs.executeScript).not.toHaveBeenCalled();
      });

      it("should truncate oversized tab content before sending it to the server", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "get-tab-content",
          tabId: 123,
          correlationId: "test-correlation-id",
        };

        const mockTab = { id: 123, url: "https://example.com" };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);
        (browser.permissions.contains as jest.Mock).mockResolvedValue(true);

        const oversizedText = "x".repeat(2_100_000);
        (browser.tabs.executeScript as jest.Mock).mockResolvedValue([
          {
            links: [{ url: "https://example.com/page", text: "Page" }],
            fullText: oversizedText,
            isTruncated: false,
            totalLength: oversizedText.length,
          },
        ]);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        const sentMessage = mockClient.sendResourceToServer.mock.calls[0][0] as TabContentExtensionMessage;
        expect(sentMessage.resource).toBe("tab-content");
        expect(sentMessage.isTruncated).toBe(true);
        expect(sentMessage.fullText.length).toBeLessThan(oversizedText.length);
        expect(sentMessage.fullText).toContain("truncated");
        expect(JSON.stringify(sentMessage).length).toBeLessThanOrEqual(2_000_000);
      });
    });

    describe("reorder-tabs command", () => {
      it("should reorder tabs and send confirmation to the server", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "reorder-tabs",
          tabOrder: [123, 456, 789],
          correlationId: "test-correlation-id",
        };

        (browser.tabs.move as jest.Mock).mockResolvedValue(undefined);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.move).toHaveBeenCalledTimes(3);
        expect(browser.tabs.move).toHaveBeenNthCalledWith(1, 123, { index: 0 });
        expect(browser.tabs.move).toHaveBeenNthCalledWith(2, 456, { index: 1 });
        expect(browser.tabs.move).toHaveBeenNthCalledWith(3, 789, { index: 2 });
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "tabs-reordered",
          correlationId: "test-correlation-id",
          tabOrder: [123, 456, 789],
        });
      });
    });

    describe("find-highlight command", () => {
      it("should find and highlight text in a tab", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "find-highlight",
          tabId: 123,
          queryPhrase: "test",
          correlationId: "test-correlation-id",
        };

        const mockFindResults = { count: 5 };
        (browser.find.find as jest.Mock).mockResolvedValue(mockFindResults);
        (browser.tabs.update as jest.Mock).mockResolvedValue(undefined);
        (browser.permissions.contains as jest.Mock).mockResolvedValue(true);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.find.find).toHaveBeenCalledWith("test", {
          tabId: 123,
          caseSensitive: true,
        });
        expect(browser.tabs.update).toHaveBeenCalledWith(123, { active: true });
        expect(browser.find.highlightResults).toHaveBeenCalledWith({
          tabId: 123,
        });
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "find-highlight-result",
          correlationId: "test-correlation-id",
          noOfResults: 5,
        });
      });

      it("should not highlight or activate tab if no results found", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "find-highlight",
          tabId: 123,
          queryPhrase: "test",
          correlationId: "test-correlation-id",
        };

        const mockFindResults = { count: 0 };
        const mockTab = { id: 123, url: "https://example.com" };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);
        (browser.find.find as jest.Mock).mockResolvedValue(mockFindResults);
        (browser.permissions.contains as jest.Mock).mockResolvedValue(true);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.update).not.toHaveBeenCalled();
        expect(browser.find.highlightResults).not.toHaveBeenCalled();
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "find-highlight-result",
          correlationId: "test-correlation-id",
          noOfResults: 0,
        });
      });

      it("should throw an error if permissions are denied", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "find-highlight",
          tabId: 123,
          queryPhrase: "test",
          correlationId: "test-correlation-id",
        };

        const mockTab = { id: 123, url: "https://example.com" };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);
        (browser.permissions.contains as jest.Mock).mockResolvedValue(false);

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow();
        expect(browser.find.find).not.toHaveBeenCalled();
      });
    });

    describe("extension 2.0 additions", () => {
      it("should answer the version handshake without an audit log entry", async () => {
        const request: ServerMessageRequest = {
          cmd: "get-extension-info",
          correlationId: "test-correlation-id",
        };

        await messageHandler.handleDecodedMessage(request);

        const sent = (mockClient.sendResourceToServer as jest.Mock).mock.calls[0][0];
        expect(sent.resource).toBe("extension-info");
        expect(sent.version).toBe("1.6.1");
        expect(sent.commands).toEqual(expect.arrayContaining(["get-tab-content", "get-extension-info"]));
        expect(browser.storage.local.set).not.toHaveBeenCalled();
      });

      it("should open a tab in the background when asked", async () => {
        (browser.tabs.create as jest.Mock).mockResolvedValue({ id: 7 });

        await messageHandler.handleDecodedMessage({
          cmd: "open-tab",
          url: "https://example.com",
          active: false,
          correlationId: "test-correlation-id",
        });

        expect(browser.tabs.create).toHaveBeenCalledWith({ url: "https://example.com", active: false });
      });

      it("should convert the page to markdown when asked", async () => {
        (browser.tabs.get as jest.Mock).mockResolvedValue({ id: 123, url: "https://example.com" });
        (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
        (browser.tabs.executeScript as jest.Mock).mockResolvedValue([
          { links: [], fullText: "# Title", isTruncated: false, totalLength: 7 },
        ]);

        await messageHandler.handleDecodedMessage({
          cmd: "get-tab-content",
          tabId: 123,
          format: "markdown",
          mainContentOnly: true,
          correlationId: "test-correlation-id",
        });

        const code = (browser.tabs.executeScript as jest.Mock).mock.calls[0][1].code as string;
        expect(code).toContain("function pageToMarkdown");
        expect(code).toContain('"mainContentOnly":true');
        expect(code).toContain('"exclude":"nav, aside, [role=navigation], [role=complementary], [role=search]"');
        expect(code).toContain(")(root, scope.exclude, true)");
        expect((mockClient.sendResourceToServer as jest.Mock).mock.calls[0][0].format).toBe("markdown");
      });

      it("should scope reading to a selector and report a selector without match", async () => {
        (browser.tabs.get as jest.Mock).mockResolvedValue({ id: 123, url: "https://example.com" });
        (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
        (browser.tabs.executeScript as jest.Mock).mockResolvedValue([
          { links: [], fullText: "Comments", isTruncated: false, totalLength: 8, scoped: true },
        ]);

        await messageHandler.handleDecodedMessage({
          cmd: "get-tab-content",
          tabId: 123,
          selector: "#comments",
          excludeSelector: ".ad",
          correlationId: "test-correlation-id",
        });

        const code = (browser.tabs.executeScript as jest.Mock).mock.calls[0][1].code as string;
        expect(code).toContain('"selector":"#comments","exclude":".ad"');
        expect(code).toContain("function visibleText");
        expect((mockClient.sendResourceToServer as jest.Mock).mock.calls[0][0].scoped).toBe(true);

        (browser.tabs.executeScript as jest.Mock).mockResolvedValue([{ missing: true }]);
        await expect(
          messageHandler.handleDecodedMessage({
            cmd: "get-tab-content",
            tabId: 123,
            selector: "#nothing",
            correlationId: "test-correlation-id",
          })
        ).rejects.toThrow('No element matches the selector "#nothing"');
      });

      it("should return to the user's tab when the consent page closes", async () => {
        (browser.tabs.get as jest.Mock).mockResolvedValue({ id: 123, url: "https://new.example" });
        (browser.permissions.contains as jest.Mock).mockResolvedValue(false);
        (browser.runtime.getURL as jest.Mock).mockReturnValue("moz-extension://x/options.html");
        (browser.tabs.query as jest.Mock).mockResolvedValue([{ id: 9 }]);
        (browser.tabs.create as jest.Mock).mockResolvedValue({ id: 50 });
        (browser.tabs.update as jest.Mock).mockResolvedValue({});

        await expect(
          messageHandler.handleDecodedMessage({ cmd: "get-tab-content", tabId: 123, correlationId: "c" })
        ).rejects.toThrow(/not yet granted permission/);

        const onRemoved = (browser.tabs.onRemoved.addListener as jest.Mock).mock.calls[0][0];
        onRemoved(77);
        expect(browser.tabs.update).not.toHaveBeenCalled();
        onRemoved(50);
        expect(browser.tabs.update).toHaveBeenCalledWith(9, { active: true });
        expect(browser.tabs.onRemoved.removeListener).toHaveBeenCalledWith(onRemoved);
      });

      it("should skip collecting links when includeLinks is false", async () => {
        (browser.tabs.get as jest.Mock).mockResolvedValue({ id: 123, url: "https://example.com" });
        (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
        (browser.tabs.executeScript as jest.Mock).mockResolvedValue([
          { links: [], fullText: "text", isTruncated: false, totalLength: 4 },
        ]);

        await messageHandler.handleDecodedMessage({
          cmd: "get-tab-content",
          tabId: 123,
          includeLinks: false,
          correlationId: "test-correlation-id",
        });

        const code = (browser.tabs.executeScript as jest.Mock).mock.calls[0][1].code as string;
        expect(code).toContain("links: []");
        expect(code).not.toContain("links: getLinks()");
      });
    });

    describe("page meta, selection and bookmarks", () => {
      beforeEach(() => {
        (browser.tabs.get as jest.Mock).mockResolvedValue({ id: 123, url: "https://example.com" });
        (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
      });

      it("should send page meta and drop oversized JSON-LD", async () => {
        (browser.tabs.executeScript as jest.Mock).mockResolvedValue([
          { title: "T", openGraph: {}, twitter: {}, alternates: [], headings: [], jsonLd: [{ big: "x".repeat(30_000) }] },
        ]);

        await messageHandler.handleDecodedMessage({ cmd: "get-page-meta", tabId: 123, correlationId: "c1" });

        const sent = (mockClient.sendResourceToServer as jest.Mock).mock.calls[0][0];
        expect(sent).toMatchObject({ resource: "page-meta", tabId: 123, meta: { title: "T" } });
        expect(JSON.stringify(sent.meta.jsonLd)).toContain("omitted");
        expect((browser.tabs.executeScript as jest.Mock).mock.calls[0][1].code).toContain("application/ld+json");
      });

      it("should refuse page meta without domain consent", async () => {
        (browser.permissions.contains as jest.Mock).mockResolvedValue(false);
        (browser.runtime.getURL as jest.Mock).mockReturnValue("moz-extension://x/options.html");

        await expect(
          messageHandler.handleDecodedMessage({ cmd: "get-page-meta", tabId: 123, correlationId: "c1" })
        ).rejects.toThrow(/not yet granted permission/);
        expect(browser.tabs.executeScript).not.toHaveBeenCalled();
      });

      it("should send the selected text", async () => {
        (browser.tabs.executeScript as jest.Mock).mockResolvedValue(["picked words"]);

        await messageHandler.handleDecodedMessage({ cmd: "get-selection", tabId: 123, correlationId: "c2" });

        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "selection",
          correlationId: "c2",
          tabId: 123,
          text: "picked words",
        });
      });

      it("should search bookmarks with folder paths and skip denied domains", async () => {
        (browser.storage.local.get as jest.Mock).mockResolvedValue({
          config: { secret: "s", ports: [8089], domainDenyList: ["blocked.example"] },
        });
        (browser.bookmarks.search as jest.Mock).mockResolvedValue([
          { id: "f1", title: "Research", parentId: "menu" },
          { id: "b1", title: "Paper", url: "https://papers.example/1", parentId: "f1", dateAdded: 5 },
          { id: "b2", title: "Hidden", url: "https://blocked.example/x", parentId: "f1" },
        ]);
        const nodes: Record<string, object> = {
          f1: { id: "f1", title: "Research", parentId: "menu" },
          menu: { id: "menu", title: "Bookmarks Menu", parentId: "root" },
          root: { id: "root", title: "" },
        };
        (browser.bookmarks.get as jest.Mock).mockImplementation(async (id: string) => [nodes[id]]);

        await messageHandler.handleDecodedMessage({ cmd: "search-bookmarks", query: "paper", correlationId: "c3" });

        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "bookmarks",
          correlationId: "c3",
          items: [{ title: "Paper", url: "https://papers.example/1", folder: "Bookmarks Menu / Research", dateAdded: 5 }],
        });
      });

      it("should ask for the bookmarks permission first", async () => {
        (browser.permissions.contains as jest.Mock).mockResolvedValue(false);
        (browser.runtime.getURL as jest.Mock).mockReturnValue("moz-extension://x/options.html");

        await expect(
          messageHandler.handleDecodedMessage({ cmd: "search-bookmarks", query: "x", correlationId: "c4" })
        ).rejects.toThrow(/bookmarks/);
        expect(browser.bookmarks.search).not.toHaveBeenCalled();
      });
    });

    describe("audit log", () => {
      it("should count repeated polling calls instead of adding entries", async () => {
        const { addAuditLogEntry } = jest.requireActual("../extension-config");
        let stored: ExtensionConfig = { secret: "s", ports: [8089], auditLog: [] };
        (browser.storage.local.get as jest.Mock).mockImplementation(async () => ({ config: stored }));
        (browser.storage.local.set as jest.Mock).mockImplementation(async ({ config }) => {
          stored = config;
        });

        const now = Date.now();
        await addAuditLogEntry({ toolId: "get-list-of-open-tabs", command: "get-tab-list", timestamp: now });
        await addAuditLogEntry({ toolId: "get-list-of-open-tabs", command: "get-tab-list", timestamp: now + 300 });
        await addAuditLogEntry({ toolId: "get-list-of-open-tabs", command: "get-tab-list", timestamp: now + 600 });
        await addAuditLogEntry({ toolId: "get-tab-web-content", command: "get-tab-content", timestamp: now + 700, url: "https://a.de" });

        expect(stored.auditLog).toHaveLength(2);
        expect(stored.auditLog?.[1]).toMatchObject({ command: "get-tab-list", count: 3, timestamp: now + 600 });
        expect(stored.auditLog?.[0]).toMatchObject({ command: "get-tab-content", url: "https://a.de" });
      });
    });

    describe("capture-screenshot command", () => {
      const request: ServerMessageRequest = {
        cmd: "capture-screenshot",
        tabId: 123,
        correlationId: "test-correlation-id",
      };

      beforeEach(() => {
        revokeCaptureConsent(123);
        (browser.tabs.captureVisibleTab as jest.Mock).mockResolvedValue(
          "data:image/jpeg;base64,QUJD"
        );
      });

      it("should refuse to capture a tab the user has not authorized", async () => {
        // Arrange
        const mockTab = {
          id: 123,
          url: "https://example.com",
          title: "Example",
          windowId: 1,
          active: true,
        };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow(/has not authorized screenshots of tab 123/);
        expect(browser.tabs.captureVisibleTab).not.toHaveBeenCalled();
        // The toolbar button is badged so the user can see which tab is waiting
        expect(browser.browserAction.setBadgeText).toHaveBeenCalledWith({
          text: "!",
          tabId: 123,
        });
      });

      it("should treat consent as revoked once the tab has navigated", async () => {
        // Arrange
        grantCaptureConsent(123, "https://example.com/first");
        const mockTab = {
          id: 123,
          url: "https://example.com/second",
          title: "Example",
          windowId: 1,
          active: true,
        };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow(/has not authorized screenshots of tab 123/);
        expect(browser.tabs.captureVisibleTab).not.toHaveBeenCalled();
      });

      it("should capture an authorized active tab and send the image to the server", async () => {
        // Arrange
        grantCaptureConsent(123, "https://example.com");
        const mockTab = {
          id: 123,
          url: "https://example.com",
          title: "Example",
          windowId: 1,
          active: true,
        };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.captureVisibleTab).toHaveBeenCalledWith(1, {
          format: "jpeg",
          quality: 70,
          scale: 1,
        });
        // An already-active tab must not be re-activated
        expect(browser.tabs.update).not.toHaveBeenCalled();
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "screenshot",
          correlationId: "test-correlation-id",
          tabId: 123,
          imageData: "QUJD",
          mimeType: "image/jpeg",
        });
      });

      it("should foreground a background tab and restore the previous one", async () => {
        // Arrange
        grantCaptureConsent(123, "https://example.com");
        const mockTab = {
          id: 123,
          url: "https://example.com",
          title: "Example",
          windowId: 1,
          active: false,
        };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);
        (browser.tabs.query as jest.Mock).mockResolvedValue([{ id: 456 }]);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.query).toHaveBeenCalledWith({
          active: true,
          windowId: 1,
        });
        expect(browser.tabs.update).toHaveBeenNthCalledWith(1, 123, {
          active: true,
        });
        expect(browser.tabs.update).toHaveBeenNthCalledWith(2, 456, {
          active: true,
        });
        expect(browser.tabs.captureVisibleTab).toHaveBeenCalled();
      });

      it("should throw an error if tab URL domain is in deny list", async () => {
        // Arrange
        grantCaptureConsent(123, "https://example.com");
        const configWithDenyList: ExtensionConfig = {
          secret: "test-secret",
          domainDenyList: ["example.com"],
          ports: [8089],
          auditLog: [],
        };
        (browser.storage.local.get as jest.Mock).mockResolvedValue({
          config: configWithDenyList,
        });

        const mockTab = {
          id: 123,
          url: "https://example.com",
          title: "Example",
          windowId: 1,
          active: true,
        };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow("Domain in tab URL is in the deny list");
        expect(browser.tabs.captureVisibleTab).not.toHaveBeenCalled();
      });

      it("should throw an error if the tool is disabled in settings", async () => {
        // Arrange
        grantCaptureConsent(123, "https://example.com");
        (browser.storage.local.get as jest.Mock).mockResolvedValue({
          config: {
            secret: "test-secret",
            toolSettings: { "capture-tab-screenshot": false },
            domainDenyList: [],
            ports: [8089],
            auditLog: [],
          } as ExtensionConfig,
        });

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow("Command 'capture-screenshot' is disabled");
        expect(browser.tabs.captureVisibleTab).not.toHaveBeenCalled();
      });
    });
  });
});
