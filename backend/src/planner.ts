import Groq from "groq-sdk";

import { config, hasGroqConfig } from "./config.js";
import { createId, truncate } from "./utils.js";
import type {
  ExtractionField,
  ExtractListField,
  MiruAction,
  PlanRequest,
  ProposedAction,
} from "./types.js";

type PlannerExtractField = {
  name: string;
  selector: string;
  attr: string;
};

type PlannerExtractListField = {
  name: string;
  attr: string;
};

type PlannerAction =
  | { type: "QUERY"; selector: string }
  | { type: "CLICK"; selector: string }
  | { type: "TYPE"; selector: string; text: string }
  | { type: "SCROLL"; direction: "up" | "down" | "to"; amount: number | null }
  | { type: "WAIT"; durationMs: number }
  | { type: "EXTRACT"; fields: PlannerExtractField[] }
  | { type: "EXTRACT_LIST"; itemSelector: string; fields: PlannerExtractListField[]; maxItems: number | null }
  | { type: "ASK_USER"; question: string; options: string[] }
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

const extractListFieldItemSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    attr: { type: "string" },
  },
  required: ["name", "attr"],
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
      type: { type: "string", enum: ["EXTRACT_LIST"] },
      itemSelector: { type: "string" },
      fields: {
        type: "array",
        minItems: 1,
        items: extractListFieldItemSchema,
      },
      maxItems: {
        anyOf: [{ type: "number" }, { type: "null" }],
      },
    },
    required: ["type", "itemSelector", "fields", "maxItems"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["ASK_USER"] },
      question: { type: "string" },
      options: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["type", "question", "options"],
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
        "Use only these action types: QUERY, CLICK, EXTRACT, EXTRACT_LIST, TYPE, SCROLL, WAIT, ASK_USER, STOP.",
        "Choose selectors from the provided interactive elements when possible.",
        "Mark risky or page-changing actions with higher risk and requiresConfirmation=true.",
        "For mode=interactive, always require confirmation.",
        "For mode=ask, require confirmation for actions that change the page.",
        "For mode=auto, Miru runs every non-ASK_USER action automatically without user approval; set requiresConfirmation=false for those. Always output exactly one next concrete step toward the full user goal (e.g. CLICK a search result, SCROLL to a section, EXTRACT_LIST player names). Use STOP only when the goal is done or impossible—do not stop after a single QUERY if the user asked for navigation or bulk extraction.",
        "Emit ASK_USER ONLY when truly blocked: the user goal is ambiguous, multiple candidate targets exist with no clear winner, or a choice is required (e.g. which of several search results to open). question must be one sentence; options is a list of short strings (can be empty if free-form). Do not use ASK_USER for confirmation of routine clicks or scrolls.",
        "The extension cannot write arbitrary paths like players.txt; use EXTRACT or EXTRACT_LIST so the user can export data from the panel.",
        "Do not invent hidden elements or unsupported actions.",
        "For EXTRACT actions, every field must include attr: use an HTML attribute name (for example href) when reading that attribute; use an empty string when the value should come from visible text instead of an attribute.",
        "Use EXTRACT_LIST when the user needs many DOM nodes matching one CSS selector (for example all links: itemSelector \"a[href]\", fields with name href and attr \"href\", plus name text and attr \"\" for visible link text on each matched element). Fields apply to each matched element; do not use per-element selectors in EXTRACT_LIST.",
        "For EXTRACT_LIST maxItems, use null for the default row cap (500), or a number between 1 and 2000.",
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

function normalizeExtractListFields(fields: PlannerExtractListField[] | undefined): ExtractListField[] {
  if (!Array.isArray(fields)) {
    return [];
  }

  return fields.map((field) => {
    const name = assertString(field.name, "EXTRACT_LIST field name");
    const rawAttr = typeof field.attr === "string" ? field.attr.trim() : "";
    return { name, attr: rawAttr };
  });
}

function coerceExtractListMaxItems(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }

  return Math.max(1, Math.min(2000, Math.floor(value)));
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
    case "EXTRACT_LIST": {
      const itemSelector = assertString(response.itemSelector, "itemSelector");
      const fields = normalizeExtractListFields(response.fields);
      if (fields.length === 0) {
        throw new Error("EXTRACT_LIST requires at least one field.");
      }

      const maxItems = coerceExtractListMaxItems(response.maxItems);
      return {
        type: "EXTRACT_LIST",
        itemSelector,
        fields,
        maxItems,
      };
    }
    case "ASK_USER": {
      const question = assertString(response.question, "ASK_USER question");
      const optionsRaw = Array.isArray(response.options) ? response.options : [];
      const options = optionsRaw
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value) => value.length > 0)
        .slice(0, 8);
      return options.length > 0
        ? { type: "ASK_USER", question, options }
        : { type: "ASK_USER", question };
    }
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

function buildAlignedNarrationMessages(request: PlanRequest, proposed: ProposedAction) {
  return [
    {
      role: "system" as const,
      content: [
        "You are Miru narrating in first person.",
        "The next browser command has ALREADY been chosen and is fixed in the user message as lockedNextCommand.",
        "Explain only this exact step in plain language. Do not describe other clicks, scrolls, waits, or extractions unless they are literally this action.",
        "Do not output JSON, code blocks, selectors as raw syntax dumps, or a different command.",
        "Under 80 words.",
      ].join(" "),
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        userGoal: request.prompt,
        pageUrl: request.context.url,
        pageTitle: request.context.title,
        lockedNextCommand: {
          action: proposed.action,
          rationale: proposed.rationale,
          risk: proposed.risk,
          requiresConfirmation: proposed.requiresConfirmation,
        },
      }),
    },
  ];
}

/**
 * Stream narration that matches the already-planned action (used after plan() in /v1/plan/stream).
 */
export async function streamAlignedNarration(
  request: PlanRequest,
  proposed: ProposedAction,
  onToken: (token: string) => Promise<void> | void
): Promise<void> {
  if (!groq) {
    await onToken(truncate(proposed.rationale, 280) || "Executing the planned step.");
    return;
  }

  try {
    const stream = await groq.chat.completions.create({
      model: config.groqModel,
      messages: buildAlignedNarrationMessages(request, proposed),
      temperature: 0.25,
      max_tokens: 200,
      stream: true,
    });

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content;
      if (typeof token === "string" && token.length > 0) {
        await onToken(token);
      }
    }
  } catch (error) {
    console.error("[Miru] Groq aligned narration stream failed:", error);
    await onToken(truncate(proposed.rationale, 280) || "Executing the planned step.");
  }
}
