import Groq from "groq-sdk";

import { config, hasGroqConfig } from "./config.js";
import { createId, truncate } from "./utils.js";
import type {
  ExtractionField,
  MiruAction,
  PlanRequest,
  ProposedAction,
} from "./types.js";

type PlannerExtractField = {
  name: string;
  selector: string;
  attr: string;
};

type PlannerAction =
  | { type: "QUERY"; selector: string }
  | { type: "CLICK"; selector: string }
  | { type: "TYPE"; selector: string; text: string }
  | { type: "SCROLL"; direction: "up" | "down" | "to"; amount: number | null }
  | { type: "WAIT"; durationMs: number }
  | { type: "EXTRACT"; fields: PlannerExtractField[] }
  | { type: "STOP"; reason: string };

interface PlannerModelResponse {
  action: PlannerAction;
  rationale: string;
  confidence: number;
  risk: "low" | "medium" | "high";
  requiresConfirmation: boolean;
}

const groq = hasGroqConfig()
  ? new Groq({
      apiKey: config.groqApiKey,
    })
  : null;

const extractionFieldItemSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    selector: { type: "string" },
    attr: { type: "string" },
  },
  required: ["name", "selector", "attr"],
} as const;

const plannerActionOneOf = [
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["QUERY"] },
      selector: { type: "string" },
    },
    required: ["type", "selector"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["CLICK"] },
      selector: { type: "string" },
    },
    required: ["type", "selector"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["TYPE"] },
      selector: { type: "string" },
      text: { type: "string" },
    },
    required: ["type", "selector", "text"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["SCROLL"] },
      direction: {
        type: "string",
        enum: ["up", "down", "to"],
      },
      amount: {
        anyOf: [{ type: "number" }, { type: "null" }],
      },
    },
    required: ["type", "direction", "amount"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["WAIT"] },
      durationMs: { type: "number" },
    },
    required: ["type", "durationMs"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["EXTRACT"] },
      fields: {
        type: "array",
        items: extractionFieldItemSchema,
      },
    },
    required: ["type", "fields"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["STOP"] },
      reason: { type: "string" },
    },
    required: ["type", "reason"],
  },
] as const;

const plannerResponseSchema = {
  name: "miru_action_plan",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        oneOf: [...plannerActionOneOf],
      },
      rationale: { type: "string" },
      confidence: { type: "number" },
      risk: {
        type: "string",
        enum: ["low", "medium", "high"],
      },
      requiresConfirmation: { type: "boolean" },
    },
    required: ["action", "rationale", "confidence", "risk", "requiresConfirmation"],
  },
} as const;

function buildPlannerMessages(request: PlanRequest) {
  const context = request.context;
  const summarizedElements = context.interactiveElements.map((element, index) => ({
    index: index + 1,
    selector: element.selector,
    label: element.label,
    tagName: element.tagName,
    role: element.role ?? null,
  }));

  return [
    {
      role: "system" as const,
      content: [
        "You are Miru's planning engine for a Chrome extension used by developers.",
        "Return only one constrained next action for the active tab.",
        "Never return JavaScript, code, prose outside the schema, or multi-step plans.",
        "Prefer read-only actions first when context is incomplete.",
        "Use only these action types: QUERY, CLICK, EXTRACT, TYPE, SCROLL, WAIT, STOP.",
        "Choose selectors from the provided interactive elements when possible.",
        "Mark risky or page-changing actions with higher risk and requiresConfirmation=true.",
        "For mode=interactive, always require confirmation.",
        "For mode=ask, require confirmation for actions that change the page.",
        "Do not invent hidden elements or unsupported actions.",
        "For EXTRACT actions, every field must include attr: use an HTML attribute name (for example href) when reading that attribute; use an empty string when the value should come from visible text instead of an attribute.",
        "For SCROLL with direction up or down, set amount to null to use the default scroll distance; for direction to, amount is the target scroll Y position in pixels (a number, never null).",
      ].join(" "),
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        mode: request.mode,
        prompt: request.prompt,
        context: {
          url: context.url,
          title: context.title,
          visibleTextLength: context.visibleTextLength,
          linkCount: context.linkCount,
          formCount: context.formCount,
          htmlPreview: truncate(context.htmlPreview, 3500),
          interactiveElements: summarizedElements,
          hasScreenshot: Boolean(context.screenshotDataUrl),
          timestamp: context.timestamp,
        },
        history: request.history ?? [],
      }),
    },
  ];
}

function buildStreamingNarrationMessages(request: PlanRequest) {
  return [
    {
      role: "system" as const,
      content: [
        "You are Miru, an AI-native browser crawler copilot.",
        "Write a concise live narration while you plan a single next command.",
        "Keep it actionable, technical, and short.",
        "Do not output JSON, markdown code blocks, or final command objects.",
        "Speak in first person as Miru and keep total output under 70 words.",
      ].join(" "),
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        mode: request.mode,
        prompt: request.prompt,
        url: request.context.url,
        title: request.context.title,
        visibleTextLength: request.context.visibleTextLength,
        interactiveElements: request.context.interactiveElements.slice(0, 18),
      }),
    },
  ];
}

function coerceConfidence(value: number): number {
  if (Number.isNaN(value)) {
    return 0.5;
  }

  return Math.max(0, Math.min(1, value));
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Planner returned an invalid ${field}.`);
  }

  return value;
}

function normalizeExtractionFields(fields: PlannerExtractField[] | undefined): ExtractionField[] {
  if (!Array.isArray(fields)) {
    return [];
  }

  return fields.map((field) => {
    const name = assertString(field.name, "EXTRACT field name");
    const selector = assertString(field.selector, "EXTRACT field selector");
    const rawAttr = typeof field.attr === "string" ? field.attr.trim() : "";
    if (rawAttr.length === 0) {
      return { name, selector };
    }

    return { name, selector, attr: rawAttr };
  });
}

function parseAction(response: PlannerModelResponse["action"]): MiruAction {
  switch (response.type) {
    case "QUERY":
      return {
        type: "QUERY",
        selector: assertString(response.selector, "selector"),
      };
    case "CLICK":
      return {
        type: "CLICK",
        selector: assertString(response.selector, "selector"),
      };
    case "TYPE":
      return {
        type: "TYPE",
        selector: assertString(response.selector, "selector"),
        text: assertString(response.text, "text"),
      };
    case "SCROLL":
      return {
        type: "SCROLL",
        direction: response.direction,
        amount:
          response.amount === null || response.amount === undefined
            ? undefined
            : response.amount,
      };
    case "WAIT":
      return {
        type: "WAIT",
        durationMs: typeof response.durationMs === "number" ? response.durationMs : 750,
      };
    case "EXTRACT":
      return {
        type: "EXTRACT",
        fields: normalizeExtractionFields(response.fields),
      };
    case "STOP":
      return {
        type: "STOP",
        reason: assertString(response.reason, "reason"),
      };
    default: {
      const _exhaustive: never = response;
      return _exhaustive;
    }
  }
}

function buildFallbackPlan(request: PlanRequest): ProposedAction {
  const context = request.context;
  const querySelector =
    context.interactiveElements.find((element) => element.tagName === "button")?.selector ||
    "main, form, button, a[href]";

  return {
    id: createId(),
    action: {
      type: "QUERY",
      selector: querySelector,
    },
    rationale: "The planner fell back to a safe inspection step because the model response was unavailable.",
    confidence: 0.32,
    risk: "low",
    requiresConfirmation: request.mode === "interactive",
  };
}

export async function planNextAction(request: PlanRequest): Promise<ProposedAction> {
  if (!groq) {
    throw new Error("GROQ_API_KEY is missing. Add it to backend/.env before starting the backend.");
  }

  try {
    const completion = await groq.chat.completions.create({
      model: config.groqModel,
      messages: buildPlannerMessages(request),
      temperature: 0.2,
      response_format: {
        type: "json_schema",
        json_schema: plannerResponseSchema,
      },
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error("Groq returned an empty planner response.");
    }

    const parsed = JSON.parse(content) as PlannerModelResponse;

    return {
      id: createId(),
      action: parseAction(parsed.action),
      rationale: truncate(assertString(parsed.rationale, "rationale"), 240),
      confidence: coerceConfidence(parsed.confidence),
      risk: parsed.risk,
      requiresConfirmation: Boolean(parsed.requiresConfirmation),
    };
  } catch (error) {
    console.error("[Miru] Groq planner failed, using fallback plan:", error);
    return buildFallbackPlan(request);
  }
}

export async function streamPlanNarration(
  request: PlanRequest,
  onToken: (token: string) => Promise<void> | void
): Promise<void> {
  if (!groq) {
    throw new Error("GROQ_API_KEY is missing. Add it to backend/.env before starting the backend.");
  }

  try {
    const stream = await groq.chat.completions.create({
      model: config.groqModel,
      messages: buildStreamingNarrationMessages(request),
      temperature: 0.35,
      stream: true,
    });

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content;
      if (typeof token === "string" && token.length > 0) {
        await onToken(token);
      }
    }
  } catch (error) {
    console.error("[Miru] Groq narration stream failed:", error);
    await onToken("I am preparing the safest next command from the current page context.");
  }
}
