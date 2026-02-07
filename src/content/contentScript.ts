/**
 * Content script for Miru
 * Reads DOM, extracts page information, and executes actions
 */

import type {
  Message,
  PageSummary,
  PageSummaryResponseMessage,
  ErrorMessage,
  QueryElementsMessage,
  HighlightElementMessage,
} from "../shared/types.js";
import { MESSAGE_SOURCE, HIGHLIGHT_STYLE_ID, HIGHLIGHT_CLASS } from "../shared/constants.js";

/**
 * Get a summary of the current page
 */
function getPageSummary(): PageSummary {
  const url = window.location.href;
  const title = document.title;

  // Get visible text (approximate)
  const bodyText = document.body.innerText || "";
  const visibleTextLength = bodyText.length;

  // Count links
  const links = document.querySelectorAll("a[href]");
  const linkCount = links.length;

  // Count forms
  const forms = document.querySelectorAll("form");
  const formCount = forms.length;

  return {
    url,
    title,
    visibleTextLength,
    linkCount,
    formCount,
    timestamp: Date.now(),
  };
}

/**
 * Query elements by selector
 */
function queryElements(selector: string): Element[] {
  try {
    return Array.from(document.querySelectorAll(selector));
  } catch (error) {
    console.error("[Miru] Invalid selector:", selector, error);
    return [];
  }
}

/**
 * Highlight an element (for debugging/inspection)
 */
function highlightElement(element: Element | null): void {
  if (!element) return;

  // Remove previous highlights
  document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((el) => {
    el.classList.remove(HIGHLIGHT_CLASS);
  });

  // Add highlight style if not already present
  if (!document.getElementById(HIGHLIGHT_STYLE_ID)) {
    const style = document.createElement("style");
    style.id = HIGHLIGHT_STYLE_ID;
    style.textContent = `
      .${HIGHLIGHT_CLASS} {
        outline: 3px solid #ff6b6b !important;
        outline-offset: 2px !important;
        background-color: rgba(255, 107, 107, 0.1) !important;
      }
    `;
    document.head.appendChild(style);
  }

  // Highlight the element
  element.classList.add(HIGHLIGHT_CLASS);

  // Scroll element into view
  element.scrollIntoView({ behavior: "smooth", block: "center" });
}

/**
 * Handle messages from service worker
 */
chrome.runtime.onMessage.addListener(
  (
    message: Message,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: Message) => void
  ) => {
    // Verify message source
    if ((message as any).source !== MESSAGE_SOURCE) {
      return false;
    }

    try {
      switch (message.type) {
        case "GET_PAGE_SUMMARY": {
          const summary = getPageSummary();
          const response: PageSummaryResponseMessage = {
            type: "PAGE_SUMMARY_RESPONSE",
            payload: summary,
          };
          sendResponse(response);
          return true;
        }

        case "QUERY_ELEMENTS": {
          const { selector } = (message as QueryElementsMessage).payload || {};
          if (!selector) {
            sendResponse({
              type: "ERROR",
              error: "Selector is required",
            } as ErrorMessage);
            return true;
          }
          const elements = queryElements(selector);
          sendResponse({
            type: "ACTION_RESULT",
            payload: {
              success: true,
              result: {
                count: elements.length,
                elements: elements.map((el) => ({
                  tagName: el.tagName,
                  id: el.id,
                  className: el.className,
                  textContent: el.textContent?.slice(0, 100),
                })),
              },
            },
          });
          return true;
        }

        case "HIGHLIGHT_ELEMENT": {
          const { selector } = (message as HighlightElementMessage).payload || {};
          if (!selector) {
            sendResponse({
              type: "ERROR",
              error: "Selector is required",
            } as ErrorMessage);
            return true;
          }
          const elements = queryElements(selector);
          if (elements.length === 0) {
            sendResponse({
              type: "ERROR",
              error: "No elements found for selector",
            } as ErrorMessage);
            return true;
          }
          highlightElement(elements[0]);
          sendResponse({
            type: "ACTION_RESULT",
            payload: {
              success: true,
              result: { highlighted: true },
            },
          });
          return true;
        }

        case "PING": {
          // Respond to ping to confirm content script is loaded
          sendResponse({ type: "PONG" } as Message);
          return true;
        }

        default:
          sendResponse({
            type: "ERROR",
            error: `Unknown message type: ${message.type}`,
          } as ErrorMessage);
          return true;
      }
    } catch (error) {
      sendResponse({
        type: "ERROR",
        error: error instanceof Error ? error.message : "Unknown error",
      } as ErrorMessage);
      return true;
    }
  }
);

// Log content script initialization
console.log("[Miru] Content script loaded on", window.location.href);

