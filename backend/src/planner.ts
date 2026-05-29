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

function summarizeAction(action: MiruAction): string {
  switch (action.type) {
    case "QUERY":
    case "CLICK":
      return `${action.type} ${action.selector}`;
    case "TYPE":
      return `TYPE ${action.selector} ← ${truncate(action.text, 80)}`;
    case "SCROLL":
      return `SCROLL ${action.direction}${action.amount !== undefined && action.amount !== null ? ` ${action.amount}` : ""}`;
    case "WAIT":
      return `WAIT ${action.durationMs}ms`;
    case "EXTRACT":
      return `EXTRACT [${action.fields.map((f) => f.name).join(", ")}]`;
    case "EXTRACT_LIST":
      return `EXTRACT_LIST ${action.itemSelector} → [${action.fields.map((f) => f.name).join(", ")}]`;
    case "ASK_USER":
      return `ASK_USER ${truncate(action.question, 80)}`;
    case "STOP":
      return `STOP ${truncate(action.reason, 80)}`;
    default:
      return "unknown";
  }
}

function buildPlannerMessages(request: PlanRequest) {
  const context = request.context;
  const summarizedElements = context.interactiveElements.map((element, index) => ({
    index: index + 1,
    selector: element.selector,
    label: element.label,
    tagName: element.tagName,
    role: element.role ?? null,
  }));

  // Compact view of recent workflow steps so the planner can apply STOP
  // discipline (e.g. "extract goal not yet satisfied because no EXTRACT step
  // has succeeded yet") and follow-up rules (e.g. "TYPE was the last step, so
  // CLICK the search button next").
  const recentSteps = (request.workflowSteps ?? []).slice(-8).map((step) => ({
    type: step.action.type,
    status: step.status,
    summary: summarizeAction(step.action),
    result: step.resultSummary ? truncate(step.resultSummary, 160) : undefined,
  }));
  const lastStep = recentSteps[recentSteps.length - 1];
  const goalSatisfied = recentSteps.some(
    (step) => (step.type === "EXTRACT" || step.type === "EXTRACT_LIST") && step.status === "succeeded"
  );

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
        "For mode=ask, require confirmation only for actions that change the page (CLICK on a submit/destructive control, TYPE into a form, navigation). Read-only actions (QUERY, EXTRACT, EXTRACT_LIST, SCROLL, WAIT) must have requiresConfirmation=false so they auto-run in the chain.",
        "For mode=auto, Miru runs every non-ASK_USER action automatically without user approval; set requiresConfirmation=false for those.",
        "REGARDLESS OF MODE, always output exactly one next concrete step toward the full user goal (e.g. CLICK a search result, SCROLL to a section, EXTRACT_LIST listing fields). The extension's service worker chains plan→execute→plan automatically after every step until the goal is satisfied; it does NOT stop after the first action. Treat every plan call as 'what is the very next thing to do toward the goal' — never as 'is the whole task done yet'.",
        // STOP discipline — the most common failure mode is the planner declaring victory
        // after a single intermediate step (TYPE, CLICK, QUERY) and stalling the loop.
        "STOP is allowed ONLY when one of these is observably true from the page context or prior history: (a) the user's full goal has been completed end-to-end (for an extraction/summary/list/csv goal this means EXTRACT or EXTRACT_LIST already returned the requested rows in this session's history — the `extractionAlreadySucceeded` signal in the user message must be true), (b) the goal is impossible from the current page (required element missing, permission denied, broken site), or (c) the user explicitly asked Miru to stop. If none of these hold, you MUST output another concrete action (CLICK, TYPE, SCROLL, WAIT, EXTRACT, EXTRACT_LIST, QUERY, or ASK_USER) instead of STOP.",
        "NEVER STOP immediately after a single TYPE, CLICK, SCROLL, QUERY, or WAIT — those are intermediate steps and never satisfy a multi-part user goal on their own. Specifically: a QUERY that only confirms an element exists is NEVER the final step — the very next plan call should EXTRACT or EXTRACT_LIST from that confirmed selector.",
        // Common follow-up patterns the planner repeatedly misses.
        "If the previous action was TYPE into a search/query input, the next action is almost always CLICK on the search/submit button, a synthetic Enter via CLICK on the search form's submit control, or a short WAIT for search results to render — typing alone does NOT trigger a search on most sites (e.g. Gmail, GitHub, Google search). Then plan an EXTRACT or EXTRACT_LIST against the rendered results.",
        "If the previous action was QUERY against a list/grid item selector, the very next action MUST be EXTRACT_LIST using that same selector as itemSelector (do not re-QUERY, do not STOP). Pick the obvious user-visible columns from the page context (e.g. title, price, address, bedrooms, link href).",
        "If the user prompt asks for data extraction or summarization (any of: \"extract\", \"get\", \"list\", \"into a file\", \"download\", \"save\", \"summarize\", \"summary\", \"csv\", \"json\", \"table\", \"export\", \"scrape\", \"all listings\", \"all items\", \"all rows\", \"all results\"), the goal is not complete until at least one EXTRACT or EXTRACT_LIST step has succeeded against the relevant rendered content. Until that happens, STOP is forbidden.",
        "If the user prompt has multiple verbs joined by 'and' / 'then' (e.g. \"search X and extract Y\"), every verb must be addressed by at least one corresponding action before STOP.",
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
        recentSteps,
        lastStep: lastStep ?? null,
        // Pre-computed signal for STOP discipline: an extraction-style goal is
        // only "potentially complete" if at least one EXTRACT/EXTRACT_LIST step
        // already succeeded in this session.
        extractionAlreadySucceeded: goalSatisfied,
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

const EXTRACTION_PROMPT_KEYWORDS = [
  "extract",
  "extracts",
  "extracted",
  "extracting",
  "get all",
  "get every",
  "list all",
  "list every",
  "summarize",
  "summary",
  "into a file",
  "into csv",
  "as csv",
  "to csv",
  "into json",
  "as json",
  "to json",
  "download",
  "save",
  "export",
  "scrape",
  "table",
  "all listings",
  "all items",
  "all rows",
  "all results",
  "all entries",
  "all records",
];

/** True when the user prompt implies "produce structured rows", so a single QUERY/CLICK is never the final step. */
function isExtractionGoal(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return EXTRACTION_PROMPT_KEYWORDS.some((kw) => normalized.includes(kw));
}

function extractionAlreadySatisfied(request: PlanRequest): boolean {
  return (request.workflowSteps ?? []).some(
    (step) =>
      (step.action.type === "EXTRACT" || step.action.type === "EXTRACT_LIST") &&
      step.status === "succeeded"
  );
}

/** Find the last succeeded QUERY's selector so we can hand the planner an obvious EXTRACT_LIST target. */
function lastSucceededQuerySelector(request: PlanRequest): string | null {
  const steps = request.workflowSteps ?? [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.action.type === "QUERY" && step.status === "succeeded") {
      return step.action.selector;
    }
  }
  return null;
}

function buildAskForExtractionFields(): MiruAction {
  return {
    type: "ASK_USER",
    question:
      "Which columns should I pull from each item on this page? (e.g. title, price, address, link)",
    options: ["title, price, address", "title, link", "all visible fields"],
  };
}

/** Run the planner once. Pulled out so we can call it twice (initial + STOP-rejection retry). */
async function callGroqPlanner(
  request: PlanRequest,
  extraSystemNote?: string
): Promise<PlannerModelResponse> {
  if (!groq) {
    throw new Error("GROQ_API_KEY is missing. Add it to backend/.env before starting the backend.");
  }

  const baseMessages = buildPlannerMessages(request);
  const messages = extraSystemNote
    ? [
        ...baseMessages,
        {
          role: "system" as const,
          content: extraSystemNote,
        },
      ]
    : baseMessages;

  const completion = await groq.chat.completions.create({
    model: config.groqModel,
    messages,
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

  return JSON.parse(content) as PlannerModelResponse;
}

export async function planNextAction(request: PlanRequest): Promise<ProposedAction> {
  if (!groq) {
    throw new Error("GROQ_API_KEY is missing. Add it to backend/.env before starting the backend.");
  }

  try {
    let parsed = await callGroqPlanner(request);
    const extractionGoal = isExtractionGoal(request.prompt);
    const goalSatisfied = extractionAlreadySatisfied(request);

    // STOP discipline enforcement: if the user's prompt is an extraction-style
    // goal and no EXTRACT/EXTRACT_LIST step has succeeded yet, the planner is
    // bailing out prematurely. Retry once with an inline corrective system note;
    // if it STOPs again, hand the user an ASK_USER with column options so the
    // session can keep moving instead of dead-ending after step 01.
    if (parsed.action.type === "STOP" && extractionGoal && !goalSatisfied) {
      console.warn(
        "[Miru] Planner returned STOP before any extraction succeeded; retrying with anti-STOP nudge."
      );
      const querySelector = lastSucceededQuerySelector(request);
      const nudge = querySelector
        ? `Your previous STOP is rejected. The user goal "${truncate(request.prompt, 120)}" requires structured rows but no EXTRACT/EXTRACT_LIST has succeeded yet. The last successful QUERY confirmed selector ${JSON.stringify(querySelector)}. Output an EXTRACT_LIST with itemSelector=${JSON.stringify(querySelector)} and a small set of obvious user-visible fields (title, price, link, address — pick what the page actually has). Set risk="low" and requiresConfirmation=false so it auto-runs. Do NOT output STOP.`
        : `Your previous STOP is rejected. The user goal "${truncate(request.prompt, 120)}" requires structured rows but no EXTRACT/EXTRACT_LIST has succeeded yet. Output a QUERY against the most likely repeating item selector on the page (e.g. a list-item class), or an EXTRACT_LIST if a clear itemSelector is already obvious from the page context. Do NOT output STOP.`;
      parsed = await callGroqPlanner(request, nudge);
    }

    let action = parseAction(parsed.action);
    let rationale = truncate(assertString(parsed.rationale, "rationale"), 240);
    let requiresConfirmation = Boolean(parsed.requiresConfirmation);
    let risk: PlannerModelResponse["risk"] = parsed.risk;

    // If the retry still STOPs, fall back to ASK_USER so the user can supply
    // the missing column hint instead of getting stuck at the previous step.
    if (action.type === "STOP" && extractionGoal && !goalSatisfied) {
      console.warn("[Miru] Planner returned STOP twice; falling back to ASK_USER for column hints.");
      action = buildAskForExtractionFields();
      rationale =
        "I want to extract structured rows here but I'm not sure which columns you need. Let me know what to pull from each item.";
      risk = "low";
      requiresConfirmation = false;
    }

    return {
      id: createId(),
      action,
      rationale,
      confidence: coerceConfidence(parsed.confidence),
      risk,
      requiresConfirmation,
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
