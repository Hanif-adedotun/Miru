/**
 * Shared type definitions for Miru extension
 */

/**
 * Action types that the AI planner can generate
 */
export type MiruAction =
  | { type: "QUERY"; selector: string }
  | { type: "CLICK"; selector: string }
  | { type: "EXTRACT"; selector: string; fields?: Record<string, string> }
  | { type: "TYPE"; selector: string; text: string }
  | { type: "SCROLL"; direction: "up" | "down" | "to"; amount?: number }
  | { type: "WAIT"; duration: number };

/**
 * Page summary information
 */
export interface PageSummary {
  url: string;
  title: string;
  visibleTextLength: number;
  linkCount: number;
  formCount: number;
  timestamp: number;
}

/**
 * Message types for communication between popup, service worker, and content script
 */
export type MessageType =
  | "PING"
  | "PONG"
  | "GET_PAGE_SUMMARY"
  | "EXECUTE_ACTION"
  | "QUERY_ELEMENTS"
  | "HIGHLIGHT_ELEMENT"
  | "PAGE_SUMMARY_RESPONSE"
  | "ACTION_RESULT"
  | "ERROR";

export interface Message {
  type: MessageType;
  payload?: unknown;
  error?: string;
}

export interface GetPageSummaryMessage extends Message {
  type: "GET_PAGE_SUMMARY";
}

export interface PageSummaryResponseMessage extends Message {
  type: "PAGE_SUMMARY_RESPONSE";
  payload: PageSummary;
}

export interface QueryElementsMessage extends Message {
  type: "QUERY_ELEMENTS";
  payload: { selector: string };
}

export interface HighlightElementMessage extends Message {
  type: "HIGHLIGHT_ELEMENT";
  payload: { selector: string };
}

export interface ExecuteActionMessage extends Message {
  type: "EXECUTE_ACTION";
  payload: MiruAction;
}

export interface ActionResultMessage extends Message {
  type: "ACTION_RESULT";
  payload: {
    success: boolean;
    result?: unknown;
    error?: string;
  };
}

export interface ErrorMessage extends Message {
  type: "ERROR";
  error: string;
}




