/**
 * WebSocket run protocol (v1) — shared between extension and backend.
 */

import type { PageAutomationOverlayPayload } from "./overlay.js";
import type {
  ActionResultPayload,
  ChatMessage,
  MiruAction,
  MiruMode,
  PageContext,
  PendingAsk,
  ProposedAction,
  ScrapeArtifact,
  SessionStatus,
  WorkflowStep,
} from "../types.js";

export const RUN_PROTOCOL_VERSION = 1 as const;

/** Inline screenshot when base64 length is at or below this (chars). */
export const SCREENSHOT_INLINE_MAX_CHARS = 200_000;

export const RUN_MAX_STEPS = 50;

// --- Client message types ---

export type ClientMessageType =
  | "client.hello"
  | "client.run.start"
  | "client.run.resume"
  | "client.context.snapshot"
  | "client.context.screenshot"
  | "client.action.result"
  | "client.run.approve"
  | "client.user.answer"
  | "client.run.cancel";

export type ServerMessageType =
  | "server.run.started"
  | "server.run.status"
  | "server.context.request"
  | "server.step.planned"
  | "server.step.running"
  | "server.step.execute"
  | "server.step.completed"
  | "server.overlay.command"
  | "server.chat.token"
  | "server.chat.done"
  | "server.chat.start"
  | "server.ask.user"
  | "server.run.awaiting_approval"
  | "server.run.completed"
  | "server.run.error";

export type RunMessageType = ClientMessageType | ServerMessageType;

export type RunStatus =
  | "starting"
  | "requesting_context"
  | "planning"
  | "awaiting_approval"
  | "awaiting_input"
  | "executing"
  | "completed"
  | "cancelled"
  | "error";

export interface RunEnvelope<T extends RunMessageType = RunMessageType, P = unknown> {
  v: typeof RUN_PROTOCOL_VERSION;
  type: T;
  runId: string;
  seq?: number;
  ts: number;
  payload: P;
}

// --- Client payloads ---

export interface ClientHelloPayload {
  extensionVersion: string;
  connectionId: string;
}

export interface ClientRunStartPayload {
  prompt: string;
  mode: MiruMode;
  tabId: number;
  origin?: string;
  url?: string;
}

export interface ClientRunResumePayload {
  runId: string;
  lastAckSeq: number;
  tabId?: number;
}

export interface ClientContextSnapshotPayload {
  pageContext: PageContext;
  /** When screenshot is large, sent in a follow-up `client.context.screenshot`. */
  screenshotOmitted?: boolean;
}

export interface ClientContextScreenshotPayload {
  screenshotDataUrl: string;
}

export interface ClientActionResultPayload {
  stepId: string;
  result: ActionResultPayload;
}

export interface ClientRunApprovePayload {
  stepId: string;
}

export interface ClientUserAnswerPayload {
  stepId: string;
  answer: string;
}

export interface ClientRunCancelPayload {
  reason?: string;
}

// --- Server payloads ---

export interface ServerRunStartedPayload {
  runId: string;
  sessionId: string;
}

export interface ServerRunStatusPayload {
  status: RunStatus;
  sessionStatus?: SessionStatus;
  label?: string;
}

export interface ServerContextRequestPayload {
  reason?: string;
}

export interface ServerStepPlannedPayload {
  step: WorkflowStep;
  proposedAction: ProposedAction;
  messageId: string;
  stepIndex: number;
}

export interface ServerStepRunningPayload {
  stepId: string;
  stepIndex: number;
}

export interface ServerStepExecutePayload {
  stepId: string;
  action: MiruAction;
  stepIndex: number;
}

export interface ServerStepCompletedPayload {
  step: WorkflowStep;
  stepIndex: number;
  scrapeArtifact?: ScrapeArtifact;
}

export interface ServerOverlayCommandPayload extends PageAutomationOverlayPayload {
  stepIndex?: number;
  stepTotal?: number;
  stepTitle?: string;
}

export interface ServerChatStartPayload {
  messageId: string;
  relatedStepId?: string;
}

export interface ServerChatTokenPayload {
  messageId: string;
  token: string;
}

export interface ServerChatDonePayload {
  messageId: string;
  error?: string;
}

export interface ServerAskUserPayload {
  pendingAsk: PendingAsk;
  stepId: string;
}

export interface ServerRunAwaitingApprovalPayload {
  stepId: string;
  proposedAction: ProposedAction;
  stepIndex: number;
}

export interface ServerRunCompletedPayload {
  workflowSteps: WorkflowStep[];
  scrapeArtifacts: ScrapeArtifact[];
  reason?: string;
}

export interface ServerRunErrorPayload {
  message: string;
  lastError?: string;
}

/** Snapshot pushed to the side panel over the local port. */
export interface RunSessionSnapshot {
  id: string | null;
  runId: string | null;
  mode: MiruMode;
  prompt: string;
  status: SessionStatus;
  runStatus?: RunStatus;
  tabId?: number;
  origin?: string;
  currentContext?: PageContext;
  pendingAction?: ProposedAction;
  pendingAsk?: PendingAsk;
  workflowSteps: WorkflowStep[];
  scrapeArtifacts: ScrapeArtifact[];
  chatMessages: ChatMessage[];
  lastError?: string;
  updatedAt: number;
}

export type ClientRunMessage =
  | RunEnvelope<"client.hello", ClientHelloPayload>
  | RunEnvelope<"client.run.start", ClientRunStartPayload>
  | RunEnvelope<"client.run.resume", ClientRunResumePayload>
  | RunEnvelope<"client.context.snapshot", ClientContextSnapshotPayload>
  | RunEnvelope<"client.context.screenshot", ClientContextScreenshotPayload>
  | RunEnvelope<"client.action.result", ClientActionResultPayload>
  | RunEnvelope<"client.run.approve", ClientRunApprovePayload>
  | RunEnvelope<"client.user.answer", ClientUserAnswerPayload>
  | RunEnvelope<"client.run.cancel", ClientRunCancelPayload>;

export type ServerRunMessage =
  | RunEnvelope<"server.run.started", ServerRunStartedPayload>
  | RunEnvelope<"server.run.status", ServerRunStatusPayload>
  | RunEnvelope<"server.context.request", ServerContextRequestPayload>
  | RunEnvelope<"server.step.planned", ServerStepPlannedPayload>
  | RunEnvelope<"server.step.running", ServerStepRunningPayload>
  | RunEnvelope<"server.step.execute", ServerStepExecutePayload>
  | RunEnvelope<"server.step.completed", ServerStepCompletedPayload>
  | RunEnvelope<"server.overlay.command", ServerOverlayCommandPayload>
  | RunEnvelope<"server.chat.start", ServerChatStartPayload>
  | RunEnvelope<"server.chat.token", ServerChatTokenPayload>
  | RunEnvelope<"server.chat.done", ServerChatDonePayload>
  | RunEnvelope<"server.ask.user", ServerAskUserPayload>
  | RunEnvelope<"server.run.awaiting_approval", ServerRunAwaitingApprovalPayload>
  | RunEnvelope<"server.run.completed", ServerRunCompletedPayload>
  | RunEnvelope<"server.run.error", ServerRunErrorPayload>;

export type RunMessage = ClientRunMessage | ServerRunMessage;

export function createRunEnvelope<T extends RunMessageType, P>(
  type: T,
  runId: string,
  payload: P,
  seq?: number
): RunEnvelope<T, P> {
  return {
    v: RUN_PROTOCOL_VERSION,
    type,
    runId,
    seq,
    ts: Date.now(),
    payload,
  };
}

export function wsUrlFromHttpBase(httpBase: string): string {
  const url = new URL(httpBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v1/runs/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function shouldInlineScreenshot(dataUrl: string | undefined): boolean {
  if (!dataUrl) {
    return false;
  }
  return dataUrl.length <= SCREENSHOT_INLINE_MAX_CHARS;
}

export function isClientMessageType(type: string): type is ClientMessageType {
  return type.startsWith("client.");
}

export function isServerMessageType(type: string): type is ServerMessageType {
  return type.startsWith("server.");
}

export function parseRunEnvelope(raw: string): RunEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as RunEnvelope;
    if (parsed?.v !== RUN_PROTOCOL_VERSION || typeof parsed.type !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
