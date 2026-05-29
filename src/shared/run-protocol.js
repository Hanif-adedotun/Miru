/**
 * WebSocket run protocol (v1) — shared between extension and backend.
 */
export const RUN_PROTOCOL_VERSION = 1;
/** Inline screenshot when base64 length is at or below this (chars). */
export const SCREENSHOT_INLINE_MAX_CHARS = 200_000;
export const RUN_MAX_STEPS = 50;
export function createRunEnvelope(type, runId, payload, seq) {
    return {
        v: RUN_PROTOCOL_VERSION,
        type,
        runId,
        seq,
        ts: Date.now(),
        payload,
    };
}
export function wsUrlFromHttpBase(httpBase) {
    const url = new URL(httpBase);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/v1/runs/ws";
    url.search = "";
    url.hash = "";
    return url.toString();
}
export function shouldInlineScreenshot(dataUrl) {
    if (!dataUrl) {
        return false;
    }
    return dataUrl.length <= SCREENSHOT_INLINE_MAX_CHARS;
}
export function isClientMessageType(type) {
    return type.startsWith("client.");
}
export function isServerMessageType(type) {
    return type.startsWith("server.");
}
export function parseRunEnvelope(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (parsed?.v !== RUN_PROTOCOL_VERSION || typeof parsed.type !== "string") {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
