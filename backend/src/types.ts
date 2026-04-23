export type MiruMode = "auto" | "ask" | "interactive";

export type ActionRisk = "low" | "medium" | "high";

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

export type MiruAction =
  | { type: "QUERY"; selector: string }
  | { type: "CLICK"; selector: string }
  | { type: "EXTRACT"; fields: ExtractionField[] }
  | { type: "TYPE"; selector: string; text: string }
  | { type: "SCROLL"; direction: "up" | "down" | "to"; amount?: number }
  | { type: "WAIT"; durationMs: number }
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

export interface PlanRequest {
  sessionId?: string;
  prompt: string;
  mode: MiruMode;
  context: PageContext;
  history?: PlannerEvent[];
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

export interface PersistedPlan {
  sessionId: string;
  prompt: string;
  mode: MiruMode;
  context: PageContext;
  proposedAction: ProposedAction;
}
