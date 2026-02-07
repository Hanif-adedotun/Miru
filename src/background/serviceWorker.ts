/**
 * Background service worker for Miru
 * Orchestrates tasks and manages communication between popup and content scripts
 */

import type {
  Message,
  GetPageSummaryMessage,
  PageSummaryResponseMessage,
  ErrorMessage,
} from "../shared/types.js";
import { CONTENT_SCRIPT_NAME, MESSAGE_SOURCE } from "../shared/constants.js";

/**
 * Inject content script into the active tab if not already injected
 */
async function ensureContentScriptInjected(tabId: number): Promise<void> {
  try {
    // Check if content script is already injected by trying to send a ping
    // If it fails, inject the script
    await chrome.tabs.sendMessage(tabId, {
      type: "PING",
      source: MESSAGE_SOURCE,
    } as Message);
  } catch (error) {
    // Content script not injected yet, inject it
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/contentScript.js"],
    });
    // Give the content script a moment to initialize
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Handle messages from popup
 */
chrome.runtime.onMessage.addListener(
  (
    message: Message,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ) => {
    // Handle messages from popup
    if (sender.id === chrome.runtime.id && message.type === "GET_PAGE_SUMMARY") {
      handleGetPageSummary(message as GetPageSummaryMessage, sendResponse);
      return true; // Indicates we will send a response asynchronously
    }

    // Forward messages from content script to popup
    if (sender.tab && message.type === "PAGE_SUMMARY_RESPONSE") {
      // This will be handled by the popup's message listener
      return false;
    }

    return false;
  }
);

/**
 * Handle GET_PAGE_SUMMARY request from popup
 */
async function handleGetPageSummary(
  message: GetPageSummaryMessage,
  sendResponse: (response: Message) => void
): Promise<void> {
  try {
    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) {
      sendResponse({
        type: "ERROR",
        error: "No active tab found",
      } as ErrorMessage);
      return;
    }

    // Ensure content script is injected
    await ensureContentScriptInjected(tab.id);

    // Send message to content script with retry logic
    let response: Message | undefined;
    let retries = 3;
    while (retries > 0) {
      try {
        response = await chrome.tabs.sendMessage(tab.id, {
          type: "GET_PAGE_SUMMARY",
          source: MESSAGE_SOURCE,
        } as Message);
        break;
      } catch (error) {
        retries--;
        if (retries > 0) {
          // Wait a bit before retrying
          await new Promise((resolve) => setTimeout(resolve, 200));
        } else {
          throw error;
        }
      }
    }

    if (response && response.type === "PAGE_SUMMARY_RESPONSE") {
      sendResponse(response as PageSummaryResponseMessage);
    } else {
      sendResponse({
        type: "ERROR",
        error: "Invalid response from content script",
      } as ErrorMessage);
    }
  } catch (error) {
    sendResponse({
      type: "ERROR",
      error: error instanceof Error ? error.message : "Unknown error",
    } as ErrorMessage);
  }
}

// Log service worker startup
console.log("[Miru] Service worker initialized");

