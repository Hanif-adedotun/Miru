import { createId, truncate } from "./utils.js";
import type {
  MiruAction,
  PageContext,
  PlanRequest,
  ProposedAction,
} from "./types.js";

function pickElementSelector(context: PageContext, matcher: RegExp, fallbackTag: string): string | null {
  const directMatch = context.interactiveElements.find((element) => matcher.test(element.label));
  if (directMatch) {
    return directMatch.selector;
  }

  const tagMatch = context.interactiveElements.find((element) => element.tagName === fallbackTag);
  return tagMatch?.selector ?? null;
}

export async function planNextAction(request: PlanRequest): Promise<ProposedAction> {
  const normalizedPrompt = request.prompt.toLowerCase();
  const context = request.context;
  const wantsExtraction = /extract|scrape|collect|grab|pull/.test(normalizedPrompt);
  const wantsTyping = /type|fill|search|enter|input/.test(normalizedPrompt);
  const wantsClick = /click|open|submit|continue|press/.test(normalizedPrompt);
  const wantsScroll = /scroll|below|lower|further/.test(normalizedPrompt);

  let action: MiruAction;
  let rationale: string;
  let risk: ProposedAction["risk"] = "low";
  let requiresConfirmation = request.mode === "interactive";

  if (wantsTyping) {
    action = {
      type: "TYPE",
      selector:
        pickElementSelector(context, /search|email|query|name|text|input/i, "input") ||
        "input, textarea",
      text: "Miru demo value",
    };
    rationale =
      "The prompt suggests entering text, so the planner targets the most likely visible input first.";
    risk = "high";
    requiresConfirmation = true;
  } else if (wantsClick) {
    action = {
      type: "CLICK",
      selector:
        pickElementSelector(context, /submit|continue|next|search|open|start/i, "button") ||
        "button, a[href]",
    };
    rationale =
      "The prompt looks action-oriented, so the planner proposes the clearest visible control as the next step.";
    risk = "medium";
    requiresConfirmation = request.mode !== "auto";
  } else if (wantsExtraction) {
    action = {
      type: "EXTRACT",
      fields: [
        { name: "pageTitle", selector: "title" },
        { name: "primaryHeading", selector: "h1" },
        { name: "firstPrimaryLink", selector: "a[href]" },
      ],
    };
    rationale =
      "The prompt asks for structured data, so the planner starts with a narrow extraction set that is easy to inspect.";
  } else if (wantsScroll) {
    action = {
      type: "SCROLL",
      direction: "down",
      amount: 720,
    };
    rationale =
      "The current page likely needs more viewport context before taking a stronger action, so scrolling is the safest next step.";
  } else {
    action = {
      type: "QUERY",
      selector: "main, form, button, a[href]",
    };
    rationale =
      "The safest default is to inspect the most relevant interactive regions before changing the page.";
  }

  return {
    id: createId(),
    action,
    rationale: truncate(rationale, 220),
    confidence: 0.66,
    risk,
    requiresConfirmation,
  };
}
