/**
 * Shared type definitions for Miru extension
 */

export type MiruMode = "auto" | "ask" | "interactive";

export type SessionStatus =
  | "idle"
  | "capturing"
  | "planning"
  | "awaiting_approval"
  | "awaiting_input"
  | "ready"
  | "executing"
  | "complete"
  | "error";

export type ActionRisk = "low" | "medium" | "high";

export type EventStatus = "info" | "success" | "warning" | "error";
export type WorkflowStepStatus =
  | "planned"
  | "approved"
  | "running"
  | "succeeded"
  | "failed"
  | "repaired"
  | "skipped";
export type ChatRole = "user" | "assistant" | "system";
export type ChatMessageStatus = "ready" | "thinking" | "running" | "complete" | "error";

export interface ElementSummary {
  selector: string;
  label: string;
  tagName: string;
  role?: string;
}

export interface ExtractionField {
  name: string;
  selector: string;
  attr?: string;
}

/** Column read from each element matched by `itemSelector` (attr empty = visible text). */
export interface ExtractListField {
  name: string;
  /** HTML attribute name, or empty string for visible text on that element. */
  attr: string;
}

export type MiruAction =
  | { type: "QUERY"; selector: string }
  | { type: "CLICK"; selector: string }
  | { type: "EXTRACT"; fields: ExtractionField[] }
  | {
      type: "EXTRACT_LIST";
      itemSelector: string;
      fields: ExtractListField[];
      /** Cap rows returned; omit or null to use default (500) in the content script. */
      maxItems?: number | null;
    }
  | { type: "TYPE"; selector: string; text: string }
  | { type: "SCROLL"; direction: "up" | "down" | "to"; amount?: number }
  | { type: "WAIT"; durationMs: number }
  | { type: "ASK_USER"; question: string; options?: string[] }
  | { type: "STOP"; reason: string };

export interface PageContext {
  url: string;
  title: string;
  visibleTextLength: number;
  linkCount: number;
  formCount: number;
  htmlPreview: string;
  interactiveElements: ElementSummary[];
  timestamp: number;
  screenshotDataUrl?: string;
}

export interface ProposedAction {
  id: string;
  action: MiruAction;
  rationale: string;
  confidence: number;
  risk: ActionRisk;
  requiresConfirmation: boolean;
}

export interface ActionResultPayload {
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface SessionEvent {
  id: string;
  title: string;
  detail: string;
  status: EventStatus;
  createdAt: number;
}

export interface WorkflowStep {
  id: string;
  action: MiruAction;
  title: string;
  rationale?: string;
  status: WorkflowStepStatus;
  resultSummary?: string;
  /** Structured result when available (e.g. extraction payloads). */
  resultData?: unknown;
  createdAt: number;
  updatedAt: number;
}

/** Tabular scrape output from a successful QUERY, EXTRACT, or EXTRACT_LIST step. */
export interface ScrapeArtifact {
  id: string;
  stepId: string;
  createdAt: number;
  source: "QUERY" | "EXTRACT" | "EXTRACT_LIST";
  label: string;
  columns: string[];
  rows: Record<string, string>[];
}

export interface SavedRoutine {
  id: string;
  name: string;
  originPattern: string;
  prompt: string;
  workflowSteps: WorkflowStep[];
  version: number;
  lastSuccessfulRunAt?: number;
  lastRepairAt?: number;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  status: ChatMessageStatus;
  createdAt: number;
  relatedStepId?: string;
}

/** Pending clarification request emitted by the planner as ASK_USER. */
export interface PendingAsk {
  stepId: string;
  question: string;
  options?: string[];
  createdAt: number;
}

export interface RecordedSession {
  id: string;
  prompt: string;
  mode: MiruMode;
  workflowSteps: WorkflowStep[];
  startedAt: number;
  completedAt?: number;
}

export interface SessionState {
  id: string | null;
  mode: MiruMode;
  prompt: string;
  status: SessionStatus;
  tabId?: number;
  origin?: string;
  currentContext?: PageContext;
  pendingAction?: ProposedAction;
  lastResult?: ActionResultPayload;
  history: SessionEvent[];
  workflowSteps?: WorkflowStep[];
  /** Aggregated table-like results from extract steps in this session. */
  scrapeArtifacts?: ScrapeArtifact[];
  /** Set when Miru needs the user to answer before continuing. Cleared on response. */
  pendingAsk?: PendingAsk;
  chatMessages?: ChatMessage[];
  isRecording?: boolean;
  recordedSession?: RecordedSession;
  lastExportedScript?: string;
  activeRoutine?: SavedRoutine;
  lastError?: string;
  createdAt?: number;
  updatedAt: number;
}

export interface PlannerEvent {
  title: string;
  detail: string;
  createdAt: number;
}

export interface PlannerRequest {
  sessionId?: string;
  prompt: string;
  mode: MiruMode;
  context: PageContext;
  history?: PlannerEvent[];
  chatMessages?: ChatMessage[];
  workflowSteps?: WorkflowStep[];
  routine?: SavedRoutine;
}

export interface PlannerResponse {
  sessionId: string;
  proposedAction: ProposedAction;
  memory: {
    previousPlans: number;
    storedInSupabase: boolean;
  };
}

export type PlannerStreamEvent =
  | {
      type: "assistant_message_start";
      messageId: string;
      sessionId?: string;
      createdAt: number;
    }
  | {
      type: "assistant_token";
      messageId: string;
      token: string;
      createdAt: number;
    }
  | {
      type: "assistant_message_done";
      messageId: string;
      createdAt: number;
    }
  | {
      type: "assistant_message_error";
      messageId: string;
      error: string;
      createdAt: number;
    };

export type MessageType =
  | "PING"
  | "PONG"
  | "GET_PAGE_CONTEXT"
  | "EXECUTE_ACTION"
  | "GET_SESSION"
  | "START_SESSION"
  | "PLAN_NEXT_ACTION"
  | "APPROVE_PENDING_ACTION"
  | "RESPOND_TO_ASK"
  | "REFRESH_CONTEXT"
  | "TOGGLE_RECORDING"
  | "EXPORT_SESSION_SCRIPT"
  | "STOP_SESSION"
  | "SUBSCRIBE_SESSION_STREAM"
  | "SESSION_STREAM_EVENT"
  | "SESSION_RESPONSE"
  | "EXPORT_SCRIPT_RESPONSE"
  | "ACTION_RESULT"
  | "ERROR";

export interface Message {
  type: MessageType;
  payload?: unknown;
  error?: string;
  source?: string;
}

export interface StartSessionPayload {
  prompt: string;
  mode: MiruMode;
}

/** Optional user line and mode before re-planning (continues an existing session). */
export interface PlanNextActionPayload {
  userMessage?: string;
  mode?: MiruMode;
}

/** Answer to a pending ASK_USER step. */
export interface RespondToAskPayload {
  stepId: string;
  answer: string;
}

export interface SessionResponseMessage extends Message {
  type: "SESSION_RESPONSE";
  payload: SessionState;
}

export interface SessionStreamEventMessage extends Message {
  type: "SESSION_STREAM_EVENT";
  payload: PlannerStreamEvent;
}

export interface ExecuteActionMessage extends Message {
  type: "EXECUTE_ACTION";
  payload: MiruAction;
}

export interface ExportScriptResponseMessage extends Message {
  type: "EXPORT_SCRIPT_RESPONSE";
  payload: {
    filename: string;
    script: string;
  };
}

export interface ActionResultMessage extends Message {
  type: "ACTION_RESULT";
  payload: ActionResultPayload;
}

export interface ErrorMessage extends Message {
  type: "ERROR";
  error: string;
}
