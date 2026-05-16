export type MiruMode = "auto" | "ask" | "interactive";

export type ActionRisk = "low" | "medium" | "high";
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

export interface ExtractListField {
  name: string;
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

export interface PlannerEvent {
  title: string;
  detail: string;
  createdAt: number;
}

export interface WorkflowStep {
  id: string;
  action: MiruAction;
  title: string;
  rationale?: string;
  status: WorkflowStepStatus;
  resultSummary?: string;
  resultData?: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  status: ChatMessageStatus;
  createdAt: number;
  relatedStepId?: string;
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

export interface PlanRequest {
  sessionId?: string;
  prompt: string;
  mode: MiruMode;
  context: PageContext;
  history?: PlannerEvent[];
  chatMessages?: ChatMessage[];
  workflowSteps?: WorkflowStep[];
  routine?: SavedRoutine;
}

export interface ProposedAction {
  id: string;
  action: MiruAction;
  rationale: string;
  confidence: number;
  risk: ActionRisk;
  requiresConfirmation: boolean;
}

export interface PlanResponse {
  sessionId: string;
  proposedAction: ProposedAction;
  memory: {
    previousPlans: number;
    storedInSupabase: boolean;
  };
}

export type PlanStreamEvent =
  | {
      event: "assistant_message_start";
      data: {
        messageId: string;
        createdAt: number;
      };
    }
  | {
      event: "assistant_token";
      data: {
        messageId: string;
        token: string;
        createdAt: number;
      };
    }
  | {
      event: "assistant_message_done";
      data: {
        messageId: string;
        createdAt: number;
      };
    }
  | {
      event: "assistant_message_error";
      data: {
        messageId: string;
        error: string;
        createdAt: number;
      };
    }
  | {
      event: "plan_result";
      data: PlanResponse;
    };

export interface PersistedPlan {
  sessionId: string;
  prompt: string;
  mode: MiruMode;
  context: PageContext;
  proposedAction: ProposedAction;
}
