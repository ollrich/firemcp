/**
 * Options page script for the FireMCP extension
 */
import {
  getSecret,
  AVAILABLE_TOOLS,
  getAllToolSettings,
  setToolEnabled,
  getDomainDenyList,
  setDomainDenyList,
  getPorts,
  setPorts,
  getAuditLog,
  clearAuditLog,
  getToolNameById,
  TAB_CHANGING_TOOLS,
  DATA_COLLECTION_FOR_PERMISSION,
} from "./extension-config";

// Texts come from _locales (English, German) in the browser's language.
const t = (key: string, ...substitutions: string[]): string =>
  browser.i18n.getMessage(key, substitutions) || key;
const toolText = (id: string, part: "name" | "description", fallback: string): string =>
  browser.i18n.getMessage(`tool_${id.replace(/-/g, "_")}_${part}`) || fallback;

function translatePage() {
  document.documentElement.lang = browser.i18n.getUILanguage().split("-")[0];
  document.title = t("optionsTitle");
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n as string);
  });
  // Links to the README in the browser's language.
  document.querySelectorAll<HTMLAnchorElement>("a[data-i18n-href]").forEach((link) => {
    link.href = t(link.dataset.i18nHref as string);
  });
}

const secretDisplay = document.getElementById(
  "secret-display"
) as HTMLDivElement;
const copyButton = document.getElementById("copy-button") as HTMLButtonElement;
const statusElement = document.getElementById("status") as HTMLDivElement;
const toolSettingsContainer = document.getElementById(
  "tool-settings-container"
) as HTMLDivElement;
const domainDenyListTextarea = document.getElementById(
  "domain-deny-list"
) as HTMLTextAreaElement;
const saveDomainListsButton = document.getElementById(
  "save-domain-lists"
) as HTMLButtonElement;
const domainStatusElement = document.getElementById(
  "domain-status"
) as HTMLDivElement;
const portsInput = document.getElementById("ports-input") as HTMLInputElement;
const savePortsButton = document.getElementById("save-ports") as HTMLButtonElement;
const portsStatusElement = document.getElementById("ports-status") as HTMLDivElement;
const auditLogContainer = document.getElementById("audit-log-container") as HTMLDivElement;
const clearAuditLogButton = document.getElementById("clear-audit-log") as HTMLButtonElement;
const auditLogStatusElement = document.getElementById("audit-log-status") as HTMLDivElement;

/**
 * Loads the secret from storage and displays it
 */
async function loadSecret() {
  try {
    const secret = await getSecret();

    // Check if secret exists
    if (secret) {
      secretDisplay.textContent = secret;
    } else {
      secretDisplay.textContent = t("secretMissing");
      secretDisplay.style.color = "red";
      copyButton.disabled = true;
    }
  } catch (error) {
    console.error("Error loading secret:", error);
    secretDisplay.textContent = t("statusLoadFailed");
    secretDisplay.style.color = "red";
    copyButton.disabled = true;
  }
}

/**
 * Copies the secret to clipboard
 */
async function copyToClipboard(event: MouseEvent) {
  if (!event.isTrusted) {
    return;
  }
  try {
    const secret = secretDisplay.textContent;
    if (
      !secret ||
      secret === "Loading..." ||
      secret.includes("No secret found") ||
      secret.includes("Error loading")
    ) {
      return;
    }

    await navigator.clipboard.writeText(secret);

    // Show success message
    statusElement.textContent = t("statusCopied");
    setTimeout(() => {
      statusElement.textContent = "";
    }, 3000);
  } catch (error) {
    console.error("Error copying to clipboard:", error);
    statusElement.textContent = t("statusCopyFailed");
    statusElement.style.color = "red";
    setTimeout(() => {
      statusElement.textContent = "";
      statusElement.style.color = "";
    }, 3000);
  }
}

/**
 * Creates the tool settings UI
 */
async function createToolSettingsUI() {
  const toolSettings = await getAllToolSettings();

  // Clear existing content
  toolSettingsContainer.innerHTML = "";

  // Reading tools first, then the ones that change tabs, each under a heading.
  const groups: [string, typeof AVAILABLE_TOOLS][] = [
    ["toolsGroupRead", AVAILABLE_TOOLS.filter((tool) => !TAB_CHANGING_TOOLS.has(tool.id))],
    ["toolsGroupTabs", AVAILABLE_TOOLS.filter((tool) => TAB_CHANGING_TOOLS.has(tool.id))],
  ];
  for (const [heading, tools] of groups) {
    const title = document.createElement("h3");
    title.textContent = t(heading);
    toolSettingsContainer.appendChild(title);
    tools.forEach((tool) => addToolRow(tool, toolSettings));
  }
}

function addToolRow(tool: (typeof AVAILABLE_TOOLS)[number], toolSettings: Record<string, boolean>) {
  const isEnabled = toolSettings[tool.id] !== false; // Default to true if not set

  const toolRow = document.createElement("div");
  toolRow.className = "tool-row";

  const labelContainer = document.createElement("div");
  labelContainer.className = "tool-label-container";

  const toolName = document.createElement("div");
  toolName.className = "tool-name";
  toolName.textContent = toolText(tool.id, "name", tool.name);

  const toolDescription = document.createElement("div");
  toolDescription.className = "tool-description";
  toolDescription.textContent = toolText(tool.id, "description", tool.description);

  labelContainer.appendChild(toolName);
  labelContainer.appendChild(toolDescription);

  const toggleContainer = document.createElement("label");
  toggleContainer.className = "toggle-switch";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = isEnabled;
  checkbox.dataset.toolId = tool.id;
  checkbox.addEventListener("change", handleToolToggle);

  const slider = document.createElement("span");
  slider.className = "slider";

  toggleContainer.appendChild(checkbox);
  toggleContainer.appendChild(slider);

  toolRow.appendChild(labelContainer);
  toolRow.appendChild(toggleContainer);

  toolSettingsContainer.appendChild(toolRow);
}

/**
 * Handles toggling a tool on/off
 */
async function handleToolToggle(event: Event) {
  const checkbox = event.target as HTMLInputElement;
  const toolId = checkbox.dataset.toolId;
  const isEnabled = checkbox.checked;

  if (!toolId) {
    console.error("Tool ID not found");
    return;
  }

  try {
    await setToolEnabled(toolId, isEnabled);
    // No status message displayed
  } catch (error) {
    console.error("Error saving tool setting:", error);

    // Revert the checkbox state
    checkbox.checked = !isEnabled;
  }
}

/**
 * Loads the domain lists from storage and displays them
 */
async function loadDomainLists() {
  try {
    // Load deny list
    const denyList = await getDomainDenyList();
    domainDenyListTextarea.value = denyList.join("\n");
  } catch (error) {
    console.error("Error loading domain lists:", error);
    domainStatusElement.textContent = t("statusLoadFailed");
    domainStatusElement.style.color = "red";
    setTimeout(() => {
      domainStatusElement.textContent = "";
      domainStatusElement.style.color = "";
    }, 3000);
  }
}

/**
 * Saves the domain lists to storage
 */
async function saveDomainLists(event: MouseEvent) {
  if (!event.isTrusted) {
    return;
  }

  try {
    // Parse deny list (split by newlines and filter out empty lines)
    const denyListText = domainDenyListTextarea.value.trim();
    const denyList = denyListText
      ? denyListText
          .split("\n")
          .map((domain) => domain.trim())
          .filter(Boolean)
      : [];

    // Save to storage
    await setDomainDenyList(denyList);

    // Show success message
    domainStatusElement.textContent = t("statusSaved");
    domainStatusElement.style.color = "#4caf50";
    setTimeout(() => {
      domainStatusElement.textContent = "";
      domainStatusElement.style.color = "";
    }, 3000);
  } catch (error) {
    console.error("Error saving domain lists:", error);
    domainStatusElement.textContent = t("statusSaveFailed");
    domainStatusElement.style.color = "red";
    setTimeout(() => {
      domainStatusElement.textContent = "";
      domainStatusElement.style.color = "";
    }, 3000);
  }
}

/**
 * Loads the ports from storage and displays them
 */
async function loadPorts() {
  try {
    const ports = await getPorts();
    portsInput.value = ports.join(", ");
  } catch (error) {
    console.error("Error loading ports:", error);
    portsStatusElement.textContent = t("statusLoadFailed");
    portsStatusElement.style.color = "red";
    setTimeout(() => {
      portsStatusElement.textContent = "";
      portsStatusElement.style.color = "";
    }, 3000);
  }
}

/**
 * Saves the ports to storage
 */
async function savePorts(event: MouseEvent) {
  if (!event.isTrusted) {
    return;
  }

  try {
    // Parse ports (split by commas and filter out empty values)
    const portsText = portsInput.value.trim();
    const portStrings = portsText
      ? portsText
          .split(",")
          .map((port) => port.trim())
          .filter(Boolean)
      : [];

    // Validate and convert to numbers
    const ports: number[] = [];
    for (const portStr of portStrings) {
      const port = parseInt(portStr, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        throw new Error(t("portsInvalid", portStr));
      }
      ports.push(port);
    }

    // Ensure at least one port is provided
    if (ports.length === 0) {
      throw new Error(t("portsMissing"));
    }

    // Save to storage
    await setPorts(ports);

    // Reload the extension:
    browser.runtime.reload();
  } catch (error) {
    console.error("Error saving ports:", error);
    portsStatusElement.textContent = error instanceof Error ? error.message : t("statusSaveFailed");
    portsStatusElement.style.color = "red";
    setTimeout(() => {
      portsStatusElement.textContent = "";
      portsStatusElement.style.color = "";
    }, 3000);
  }
}

/**
 * Loads the audit log from storage and displays it
 */
async function loadAuditLog() {
  try {
    const auditLog = await getAuditLog();
    
    // Clear existing content
    auditLogContainer.innerHTML = "";
    
    if (auditLog.length === 0) {
      // Show empty state
      const emptyDiv = document.createElement("div");
      emptyDiv.className = "audit-log-empty";
      emptyDiv.textContent = t("auditEmpty");
      auditLogContainer.appendChild(emptyDiv);
      return;
    }
    
    // Create table
    const table = document.createElement("table");
    table.className = "audit-log-table";
    
    // Create header
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    
    const headers = [t("auditColTool"), t("auditColTime"), t("auditColSite")];
    headers.forEach(headerText => {
      const th = document.createElement("th");
      th.textContent = headerText;
      headerRow.appendChild(th);
    });
    
    thead.appendChild(headerRow);
    table.appendChild(thead);
    
    // Create body
    const tbody = document.createElement("tbody");
    
    auditLog.forEach(entry => {
      const row = document.createElement("tr");
      
      // Tool name
      const toolCell = document.createElement("td");
      toolCell.textContent =
        toolText(entry.toolId, "name", getToolNameById(entry.toolId)) +
        (entry.count && entry.count > 1 ? ` (×${entry.count})` : "");
      row.appendChild(toolCell);
      
      // Timestamp
      const timestampCell = document.createElement("td");
      timestampCell.className = "audit-log-timestamp";
      const date = new Date(entry.timestamp);
      timestampCell.textContent = date.toLocaleString();
      row.appendChild(timestampCell);
      
      // URL Domain
      const urlCell = document.createElement("td");
      urlCell.className = "audit-log-url";
      if (entry.url) {
        // Show only the domain part of the URL
        try {
          const urlObj = new URL(entry.url);
          urlCell.textContent = urlObj.hostname;
        } catch (e) {
          console.error("Invalid URL in audit log entry:", e);
          urlCell.textContent = "Invalid URL";
        }
      } else {
        urlCell.textContent = "-";
      }
      row.appendChild(urlCell);
      
      tbody.appendChild(row);
    });
    
    table.appendChild(tbody);
    auditLogContainer.appendChild(table);
    
  } catch (error) {
    console.error("Error loading audit log:", error);
    auditLogContainer.textContent = t("statusLoadFailed");
  }
}

/**
 * Clears the audit log
 */
async function handleClearAuditLog(event: MouseEvent) {
  if (!event.isTrusted) {
    return;
  }

  try {
    await clearAuditLog();
    
    // Reload the audit log display
    await loadAuditLog();
    
    // Show success message
    auditLogStatusElement.textContent = t("statusCleared");
    auditLogStatusElement.style.color = "#4caf50";
    setTimeout(() => {
      auditLogStatusElement.textContent = "";
      auditLogStatusElement.style.color = "";
    }, 3000);
  } catch (error) {
    console.error("Error clearing audit log:", error);
    auditLogStatusElement.textContent = t("statusSaveFailed");
    auditLogStatusElement.style.color = "red";
    setTimeout(() => {
      auditLogStatusElement.textContent = "";
      auditLogStatusElement.style.color = "";
    }, 3000);
  }
}

/**
 * Initializes the collapsible sections
 */
function initializeCollapsibleSections() {
  const sectionHeaders = document.querySelectorAll(".section-container > h2");

  sectionHeaders.forEach((header) => {
    // Add click event listener to toggle section visibility
    header.addEventListener("click", (event) => {
      event.preventDefault();

      // Toggle the collapsed class on the header
      header.classList.toggle("collapsed");

      // Toggle the collapsed class on the section content
      const sectionContent = header.nextElementSibling as HTMLElement;
      sectionContent.classList.toggle("collapsed");
    });
  });
}

function showPermissionRequest(url: string) {
  const domain = new URL(url).hostname;
  const origin = new URL(url).origin;

  // Show the modal and hide the main content
  const modal = document.getElementById("permission-modal") as HTMLDivElement;
  const mainContent = document.getElementById("main-content") as HTMLDivElement;
  const domainElement = document.getElementById("permission-domain") as HTMLDivElement;
  const grantBtn = document.getElementById("grant-btn") as HTMLButtonElement;
  const cancelBtn = document.getElementById("cancel-btn") as HTMLButtonElement;
  const permissionText = document.getElementById("permission-text") as HTMLParagraphElement;

  (document.getElementById("permission-title") as HTMLElement).textContent = t("consentTitleSite");
  domainElement.textContent = domain;
  permissionText.textContent = t("consentTextSite");

  // Show modal and blur main content
  modal.classList.remove("hidden");
  mainContent.classList.add("modal-open");

  // Handle grant permission button click
  const handleGrant = async () => {
    try {
      const granted = await browser.permissions.request({
        origins: [`${origin}/*`],
      });

      if (granted) {
        // Permission granted, close the window or redirect back
        window.close();
      } else {
        // Permission denied, hide modal and show main content
        hidePermissionModal();
      }
    } catch (error) {
      console.error("Error requesting permission:", error);
      hidePermissionModal();
    }
  };

  // Handle cancel button click
  const handleCancel = () => {
    hidePermissionModal();
  };

  // Add event listeners
  grantBtn.addEventListener("click", handleGrant);
  cancelBtn.addEventListener("click", handleCancel);

  // Store references to remove listeners later
  (window as any).permissionHandlers = {
    handleGrant,
    handleCancel,
    grantBtn,
    cancelBtn
  };
}

function showGlobalPermissionRequest(permissions: string[]) {
  // Show the modal and hide the main content
  const modal = document.getElementById("permission-modal") as HTMLDivElement;
  const mainContent = document.getElementById("main-content") as HTMLDivElement;
  const domainElement = document.getElementById("permission-domain") as HTMLDivElement;
  const grantBtn = document.getElementById("grant-btn") as HTMLButtonElement;
  const cancelBtn = document.getElementById("cancel-btn") as HTMLButtonElement;
  const permissionText = document.getElementById("permission-text") as HTMLParagraphElement;

  (document.getElementById("permission-title") as HTMLElement).textContent = t("consentTitleFeature");
  domainElement.textContent = "";
  permissionText.textContent = permissions.map((permission) => t(`consentFeature_${permission}`)).join(" ");

  // Show modal and blur main content
  modal.classList.remove("hidden");
  mainContent.classList.add("modal-open");

  // Handle grant permission button click
  const handleGrant = async () => {
    try {
      const dataCollection = permissions.flatMap((permission) => DATA_COLLECTION_FOR_PERMISSION[permission] ?? []);
      const granted = await browser.permissions.request({
        permissions: permissions as browser.permissions.Permissions["permissions"],
        // Not yet in @types/firefox-webext-browser.
        ...(dataCollection.length ? { data_collection: dataCollection } : {}),
      } as browser.permissions.Permissions);

      if (granted) {
        // Permission granted, close the window or redirect back
        window.close();
      } else {
        // Permission denied, hide modal and show main content
        hidePermissionModal();
      }
    } catch (error) {
      console.error("Error requesting permission:", error);
      hidePermissionModal();
    }
  };

  // Handle cancel button click
  const handleCancel = () => {
    hidePermissionModal();
  };

  // Add event listeners
  grantBtn.addEventListener("click", handleGrant);
  cancelBtn.addEventListener("click", handleCancel);

  // Store references to remove listeners later
  (window as any).permissionHandlers = {
    handleGrant,
    handleCancel,
    grantBtn,
    cancelBtn
  };
}

function hidePermissionModal() {
  const modal = document.getElementById("permission-modal") as HTMLDivElement;
  const mainContent = document.getElementById("main-content") as HTMLDivElement;

  // Hide modal and restore main content
  modal.classList.add("hidden");
  mainContent.classList.remove("modal-open");

  // Clean up event listeners
  const handlers = (window as any).permissionHandlers;
  if (handlers) {
    handlers.grantBtn.removeEventListener("click", handlers.handleGrant);
    handlers.cancelBtn.removeEventListener("click", handlers.handleCancel);
    delete (window as any).permissionHandlers;
  }
}

// Initialize the page
copyButton.addEventListener("click", copyToClipboard);
saveDomainListsButton.addEventListener("click", saveDomainLists);
savePortsButton.addEventListener("click", savePorts);
clearAuditLogButton.addEventListener("click", handleClearAuditLog);
document.addEventListener("DOMContentLoaded", () => {
  translatePage();
  loadSecret();
  createToolSettingsUI();
  loadDomainLists();
  loadPorts();
  loadAuditLog();
  initializeCollapsibleSections();

  // Ensure modal is hidden by default
  const modal = document.getElementById("permission-modal") as HTMLDivElement;
  const mainContent = document.getElementById("main-content") as HTMLDivElement;
  modal.classList.add("hidden");
  mainContent.classList.remove("modal-open");

  const params = new URLSearchParams(window.location.search);
  const requestUrl = params.get("requestUrl");
  const requestPermissions = params.get("requestPermissions");

  if (requestUrl) {
    // Show UI for requesting permission for this specific URL
    showPermissionRequest(requestUrl);
  } else if (requestPermissions) {
    // Show UI for requesting global permissions
    try {
      const permissions = JSON.parse(decodeURIComponent(requestPermissions));
      showGlobalPermissionRequest(permissions);
    } catch (error) {
      console.error("Error parsing requestPermissions:", error);
    }
  }

  // Add interval to refresh the audit log every 5 seconds:
  setInterval(() => {
    loadAuditLog();
  }, 5000);
});
