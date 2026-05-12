/**
 * Content script for Miru
 * Reads DOM, extracts page information, and executes constrained actions
 */

import type {
  ActionResultMessage,
  ElementSummary,
  ErrorMessage,
  ExecuteActionMessage,
  ExtractionField,
  ExtractListField,
  Message,
  MiruAction,
  PageContext,
} from "../shared/types.js";
import {
  HIGHLIGHT_CLASS,
  HIGHLIGHT_STYLE_ID,
  MESSAGE_SOURCE,
} from "../shared/constants.js";

function buildSelector(element: Element): string {
  if (element.id) {
    return `#${CSS.escape(element.id)}`;
  }

  const namedElement = element as HTMLElement;
  if (namedElement.dataset?.miruSelector) {
    return namedElement.dataset.miruSelector;
  }

  const tagName = element.tagName.toLowerCase();
  const classes = Array.from(element.classList).slice(0, 2).map((name) => `.${CSS.escape(name)}`);

  if (classes.length > 0) {
    return `${tagName}${classes.join("")}`;
  }

  const parent = element.parentElement;
  if (!parent) {
    return tagName;
  }

  const siblings = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
  const position = siblings.indexOf(element) + 1;
  return `${tagName}:nth-of-type(${position})`;
}

function summarizeElement(element: Element): ElementSummary {
  const htmlElement = element as HTMLElement;
  const text = (htmlElement.innerText || htmlElement.getAttribute("aria-label") || htmlElement.id || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72);

  return {
    selector: buildSelector(element),
    label: text || element.tagName.toLowerCase(),
    tagName: element.tagName.toLowerCase(),
    role: htmlElement.getAttribute("role") || undefined,
  };
}

function getInteractiveElements(): ElementSummary[] {
  const selector = 'button, a[href], input, textarea, select, [role="button"]';
  const elements = Array.from(document.querySelectorAll(selector))
    .filter((element) => {
      const htmlElement = element as HTMLElement;
      const style = window.getComputedStyle(htmlElement);
      return style.display !== "none" && style.visibility !== "hidden";
    })
    .slice(0, 12);

  return elements.map(summarizeElement);
}

function getHtmlPreview(): string {
  const source = document.body?.innerHTML || "";
  return source.replace(/\s+/g, " ").trim().slice(0, 5000);
}

function getPageContext(): PageContext {
  const bodyText = document.body?.innerText || "";

  return {
    url: window.location.href,
    title: document.title,
    visibleTextLength: bodyText.length,
    linkCount: document.querySelectorAll("a[href]").length,
    formCount: document.querySelectorAll("form").length,
    htmlPreview: getHtmlPreview(),
    interactiveElements: getInteractiveElements(),
    timestamp: Date.now(),
  };
}

function queryElement(selector: string): Element | null {
  try {
    return document.querySelector(selector);
  } catch (error) {
    console.error("[Miru] Invalid selector:", selector, error);
    return null;
  }
}

function ensureHighlightStyle(): void {
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      outline: 3px solid rgba(56, 189, 248, 0.95) !important;
      outline-offset: 3px !important;
      box-shadow: 0 0 0 6px rgba(125, 211, 252, 0.22) !important;
      border-radius: 12px !important;
      transition: box-shadow 180ms ease, outline-color 180ms ease !important;
    }
  `;

  document.head.appendChild(style);
}

function highlightElement(element: Element | null): void {
  if (!element) {
    return;
  }

  ensureHighlightStyle();
  document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((node) => {
    node.classList.remove(HIGHLIGHT_CLASS);
  });

  element.classList.add(HIGHLIGHT_CLASS);
  (element as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
}

function extractField(field: ExtractionField): string | null {
  const element = queryElement(field.selector);
  if (!element) {
    return null;
  }

  if (field.attr) {
    return element.getAttribute(field.attr);
  }

  return (element as HTMLElement).innerText?.trim() || element.textContent?.trim() || null;
}

function extractListFieldFromElement(element: Element, field: ExtractListField): string | null {
  if (field.attr) {
    return element.getAttribute(field.attr);
  }

  const htmlElement = element as HTMLElement;
  return htmlElement.innerText?.trim() || element.textContent?.trim() || null;
}

async function executeAction(message: ExecuteActionMessage): Promise<ActionResultMessage | ErrorMessage> {
  const action = message.payload;

  try {
    switch (action.type) {
      case "QUERY": {
        const element = queryElement(action.selector);
        if (!element) {
          return { type: "ERROR", error: "No element found for selector" };
        }

        highlightElement(element);
        return {
          type: "ACTION_RESULT",
          payload: {
            success: true,
            result: summarizeElement(element),
          },
        };
      }

      case "CLICK": {
        const element = queryElement(action.selector);
        if (!element) {
          return { type: "ERROR", error: "No clickable element found for selector" };
        }

        highlightElement(element);
        (element as HTMLElement).click();

        return {
          type: "ACTION_RESULT",
          payload: {
            success: true,
            result: { clicked: action.selector },
          },
        };
      }

      case "TYPE": {
        const element = queryElement(action.selector);
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
          return { type: "ERROR", error: "Target is not a text input" };
        }

        highlightElement(element);
        element.focus();
        element.value = action.text;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));

        return {
          type: "ACTION_RESULT",
          payload: {
            success: true,
            result: { typed: true, selector: action.selector },
          },
        };
      }

      case "SCROLL": {
        const amount = action.amount ?? 640;
        if (action.direction === "up") {
          window.scrollBy({ top: -amount, behavior: "smooth" });
        } else if (action.direction === "down") {
          window.scrollBy({ top: amount, behavior: "smooth" });
        } else {
          window.scrollTo({ top: amount, behavior: "smooth" });
        }

        return {
          type: "ACTION_RESULT",
          payload: {
            success: true,
            result: { direction: action.direction, amount },
          },
        };
      }

      case "WAIT": {
        await new Promise((resolve) => setTimeout(resolve, action.durationMs));
        return {
          type: "ACTION_RESULT",
          payload: {
            success: true,
            result: { waited: action.durationMs },
          },
        };
      }

      case "EXTRACT": {
        const extracted = action.fields.reduce<Record<string, string | null>>((accumulator, field) => {
          accumulator[field.name] = extractField(field);
          return accumulator;
        }, {});

        return {
          type: "ACTION_RESULT",
          payload: {
            success: true,
            result: extracted,
          },
        };
      }

      case "EXTRACT_LIST": {
        let nodes: Element[];
        try {
          nodes = Array.from(document.querySelectorAll(action.itemSelector));
        } catch {
          return { type: "ERROR", error: "Invalid itemSelector for EXTRACT_LIST" };
        }

        const requestedCap =
          action.maxItems === null || action.maxItems === undefined ? 500 : action.maxItems;
        const cap = Math.min(Math.max(1, requestedCap), 2000);
        const slice = nodes.slice(0, cap);
        const rows = slice.map((element) => {
          const row: Record<string, string | null> = {};
          for (const field of action.fields) {
            row[field.name] = extractListFieldFromElement(element, field);
          }
          return row;
        });

        highlightElement(slice[0] ?? null);

        return {
          type: "ACTION_RESULT",
          payload: {
            success: true,
            result: { rows },
          },
        };
      }

      case "STOP": {
        return {
          type: "ACTION_RESULT",
          payload: {
            success: true,
            result: { stopped: true, reason: action.reason },
          },
        };
      }

      default:
        return {
          type: "ERROR",
          error: `Unknown action type: ${(action as MiruAction).type}`,
        };
    }
  } catch (error) {
    return {
      type: "ERROR",
      error: error instanceof Error ? error.message : "Unknown action failure",
    };
  }
}

chrome.runtime.onMessage.addListener(
  (
    message: Message,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: Message) => void
  ) => {
    if (message.source !== MESSAGE_SOURCE) {
      return false;
    }

    if (message.type === "PING") {
      sendResponse({ type: "PONG" });
      return true;
    }

    if (message.type === "GET_PAGE_CONTEXT") {
      sendResponse({
        type: "ACTION_RESULT",
        payload: {
          success: true,
          result: getPageContext(),
        },
      });
      return true;
    }

    if (message.type === "EXECUTE_ACTION") {
      void executeAction(message as ExecuteActionMessage).then((response) => sendResponse(response));
      return true;
    }

    sendResponse({
      type: "ERROR",
      error: `Unsupported message type: ${message.type}`,
    });
    return true;
  }
);

console.log("[Miru] Content script loaded on", window.location.href);
