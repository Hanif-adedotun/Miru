import { MIRU_BACKEND_URL } from "../generated/runtime-config.js";
import type {
  ChatMessage,
  PlannerStreamEvent,
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

function mapChatMessages(messages: ChatMessage[]): PlannerRequest["chatMessages"] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    status: message.status,
    createdAt: message.createdAt,
    relatedStepId: message.relatedStepId,
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
      chatMessages: request.chatMessages ? mapChatMessages(request.chatMessages) : [],
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

type StreamPayload =
  | {
      messageId: string;
      createdAt: number;
    }
  | {
      messageId: string;
      token: string;
      createdAt: number;
    }
  | {
      messageId: string;
      error: string;
      createdAt: number;
    }
  | PlannerResponse;

interface StreamEventFrame {
  event: string;
  data: StreamPayload;
}

function parseStreamFrame(rawEvent: string, rawData: string): StreamEventFrame {
  let parsedData: unknown;
  try {
    parsedData = JSON.parse(rawData);
  } catch {
    parsedData = {};
  }

  return {
    event: rawEvent,
    data: parsedData as StreamPayload,
  };
}

function toPlannerStreamEvent(frame: StreamEventFrame): PlannerStreamEvent | null {
  const { event, data } = frame;
  if (event === "assistant_message_start" && "messageId" in data) {
    return { type: "assistant_message_start", messageId: data.messageId, createdAt: data.createdAt };
  }
  if (event === "assistant_token" && "messageId" in data && "token" in data) {
    return { type: "assistant_token", messageId: data.messageId, token: data.token, createdAt: data.createdAt };
  }
  if (event === "assistant_message_done" && "messageId" in data) {
    return { type: "assistant_message_done", messageId: data.messageId, createdAt: data.createdAt };
  }
  if (event === "assistant_message_error" && "messageId" in data && "error" in data) {
    return {
      type: "assistant_message_error",
      messageId: data.messageId,
      error: data.error,
      createdAt: data.createdAt,
    };
  }
  return null;
}

export async function fetchNextActionStream(
  request: PlannerRequest,
  onEvent: (event: PlannerStreamEvent) => Promise<void> | void
): Promise<{ sessionId: string; proposedAction: ProposedAction }> {
  const response = await fetch(`${MIRU_BACKEND_URL}/v1/plan/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...request,
      history: request.history ? mapHistory(request.history) : [],
      chatMessages: request.chatMessages ? mapChatMessages(request.chatMessages) : [],
    }),
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(errorBody?.error || `Planner stream failed with status ${response.status}.`);
  }

  if (!response.body) {
    throw new Error("Planner stream response body is unavailable.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let currentData = "";
  let result: { sessionId: string; proposedAction: ProposedAction } | null = null;

  const flushFrame = async (): Promise<void> => {
    if (!currentEvent || !currentData) {
      currentEvent = "";
      currentData = "";
      return;
    }

    const frame = parseStreamFrame(currentEvent, currentData);
    if (frame.event === "plan_result" && "sessionId" in frame.data && "proposedAction" in frame.data) {
      result = {
        sessionId: frame.data.sessionId,
        proposedAction: frame.data.proposedAction,
      };
    } else {
      const mapped = toPlannerStreamEvent(frame);
      if (mapped) {
        await onEvent(mapped);
      }
    }

    currentEvent = "";
    currentData = "";
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      await flushFrame();
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        currentData += line.slice(5).trim();
        continue;
      }
      if (line.trim() === "") {
        await flushFrame();
      }
    }
  }

  if (!result) {
    throw new Error("Planner stream ended without a final plan result.");
  }

  return result;
}
