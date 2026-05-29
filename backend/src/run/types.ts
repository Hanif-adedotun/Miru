import type {
  ChatMessage,
  MiruMode,
  PageContext,
  PendingAsk,
  ProposedAction,
  ScrapeArtifact,
  WorkflowStep,
} from "../types.js";

export type RunPhase =
  | "starting"
  | "idle"
  | "requesting_context"
  | "planning"
  | "awaiting_approval"
  | "awaiting_input"
  | "executing"
  | "completed"
  | "cancelled"
  | "error";

export type RunWaitKind = "context" | "approval" | "answer" | "action_result" | null;

export interface RunRecord {
  runId: string;
  sessionId: string;
  connectionId: string;
  mode: MiruMode;
  prompt: string;
  tabId: number;
  origin?: string;
  url?: string;
  phase: RunPhase;
  workflowSteps: WorkflowStep[];
  chatMessages: ChatMessage[];
  scrapeArtifacts: ScrapeArtifact[];
  currentContext?: PageContext;
  pendingAction?: ProposedAction;
  pendingAsk?: PendingAsk;
  waitKind: RunWaitKind;
  pendingScreenshot?: string;
  stepCount: number;
  seq: number;
  lastError?: string;
  cancelled: boolean;
  createdAt: number;
  updatedAt: number;
}
