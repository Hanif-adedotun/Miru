import type { RunStreamEvent, SessionStreamEventMessage } from "../shared/types.js";

export const SESSION_STREAM_PORT = "miru-session-stream";

const streamPorts = new Set<chrome.runtime.Port>();

export function registerStreamPort(port: chrome.runtime.Port): void {
  if (port.name !== SESSION_STREAM_PORT) {
    return;
  }

  streamPorts.add(port);
  port.onDisconnect.addListener(() => {
    streamPorts.delete(port);
  });
}

export function broadcastStreamEvent(event: RunStreamEvent): void {
  const message: SessionStreamEventMessage = {
    type: "SESSION_STREAM_EVENT",
    payload: event,
  };

  for (const port of streamPorts) {
    try {
      port.postMessage(message);
    } catch {
      streamPorts.delete(port);
    }
  }
}
