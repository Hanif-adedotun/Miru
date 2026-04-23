import { MIRU_BACKEND_URL } from "../generated/runtime-config.js";
import type {
  PlannerEvent,
  PlannerRequest,
  PlannerResponse,
  ProposedAction,
} from "../shared/types.js";

function mapHistory(history: PlannerEvent[]): PlannerRequest["history"] {
  return history.map((event) => ({
    title: event.title,
    detail: event.detail,
    createdAt: event.createdAt,
  }));
}

export async function fetchNextAction(request: PlannerRequest): Promise<{
  sessionId: string;
  proposedAction: ProposedAction;
}> {
  const response = await fetch(`${MIRU_BACKEND_URL}/v1/plan`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...request,
      history: request.history ? mapHistory(request.history) : [],
    }),
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(errorBody?.error || `Planner request failed with status ${response.status}.`);
  }

  const payload = (await response.json()) as PlannerResponse;
  return {
    sessionId: payload.sessionId,
    proposedAction: payload.proposedAction,
  };
}
