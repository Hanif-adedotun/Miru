import { MESSAGE_SOURCE, SCREENSHOT_QUALITY } from "../shared/constants.js";
import type { PageAutomationOverlayPayload } from "../shared/overlay.js";
import type {
  ActionResultMessage,
  ActionResultPayload,
  ErrorMessage,
  Message,
  MiruAction,
  PageContext,
} from "../shared/types.js";

export async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.windowId) {
    throw new Error("No active browser tab found.");
  }

  return tab;
}

export async function getTabById(tabId: number): Promise<chrome.tabs.Tab> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.id) {
    throw new Error("Tab is no longer available.");
  }
  return tab;
}

export async function ensureContentScriptInjected(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "PING",
      source: MESSAGE_SOURCE,
    } as Message);
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/contentScript.js"],
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

export async function capturePageContext(tab: chrome.tabs.Tab): Promise<PageContext> {
  if (!tab.id || !tab.windowId) {
    throw new Error("Active tab is missing required identifiers.");
  }

  await ensureContentScriptInjected(tab.id);

  const response = (await chrome.tabs.sendMessage(tab.id, {
    type: "GET_PAGE_CONTEXT",
    source: MESSAGE_SOURCE,
  } as Message)) as ActionResultMessage | ErrorMessage;

  if (response.type === "ERROR") {
    throw new Error(response.error || "Failed to read page context.");
  }

  if (!response.payload.success) {
    throw new Error(response.payload.error || "Failed to read page context.");
  }

  const context = response.payload.result as PageContext;
  let screenshotDataUrl: string | undefined;

  try {
    screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: SCREENSHOT_QUALITY,
    });
  } catch (error) {
    console.warn("[Miru] Screenshot capture failed:", error);
  }

  return {
    ...context,
    screenshotDataUrl,
  };
}

export async function executeActionOnTab(
  tabId: number,
  action: MiruAction
): Promise<ActionResultPayload> {
  await ensureContentScriptInjected(tabId);

  const response = (await chrome.tabs.sendMessage(tabId, {
    type: "EXECUTE_ACTION",
    source: MESSAGE_SOURCE,
    payload: action,
  } as Message)) as ActionResultMessage | ErrorMessage;

  if (response.type === "ERROR") {
    return {
      success: false,
      error: response.error,
    };
  }

  return response.payload;
}

export async function syncPageOverlay(
  tabId: number | undefined,
  payload: PageAutomationOverlayPayload
): Promise<void> {
  if (!tabId) {
    return;
  }

  try {
    await ensureContentScriptInjected(tabId);
    await chrome.tabs.sendMessage(tabId, {
      type: "SET_PAGE_OVERLAY",
      source: MESSAGE_SOURCE,
      payload,
    } as Message);
  } catch (error) {
    console.warn("[Miru] Page overlay sync failed:", error);
  }
}

export async function clearPageOverlay(tabId: number | undefined): Promise<void> {
  await syncPageOverlay(tabId, { active: false, phase: "idle" });
}
