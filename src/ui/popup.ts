/**
 * Popup UI controller for Miru
 * Handles user interactions and displays results
 */

import type {
  Message,
  GetPageSummaryMessage,
  PageSummaryResponseMessage,
  ErrorMessage,
} from "../shared/types.js";

const getSummaryBtn = document.getElementById("getSummaryBtn") as HTMLButtonElement;
const output = document.getElementById("output") as HTMLDivElement;
const summaryContent = document.getElementById("summaryContent") as HTMLPreElement;
const errorDiv = document.getElementById("error") as HTMLDivElement;

/**
 * Show error message
 */
function showError(message: string): void {
  errorDiv.textContent = message;
  errorDiv.classList.remove("hidden");
  output.classList.add("hidden");
}

/**
 * Show success output
 */
function showOutput(data: unknown): void {
  errorDiv.classList.add("hidden");
  summaryContent.textContent = JSON.stringify(data, null, 2);
  output.classList.remove("hidden");
}

/**
 * Handle get page summary button click
 */
getSummaryBtn.addEventListener("click", async () => {
  getSummaryBtn.disabled = true;
  getSummaryBtn.textContent = "Loading...";

  try {
    // Send message to service worker
    const message: GetPageSummaryMessage = {
      type: "GET_PAGE_SUMMARY",
    };

    const response = await chrome.runtime.sendMessage(message);

    if (response && response.type === "PAGE_SUMMARY_RESPONSE") {
      const summaryResponse = response as PageSummaryResponseMessage;
      showOutput(summaryResponse.payload);
    } else if (response && response.type === "ERROR") {
      const errorResponse = response as ErrorMessage;
      showError(errorResponse.error || "Unknown error");
    } else {
      showError("Invalid response from service worker");
    }
  } catch (error) {
    showError(error instanceof Error ? error.message : "Failed to get page summary");
  } finally {
    getSummaryBtn.disabled = false;
    getSummaryBtn.textContent = "Get Page Summary";
  }
});

// Initialize
console.log("[Miru] Popup initialized");

