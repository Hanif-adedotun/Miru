import { MIRU_BACKEND_URL } from "../generated/runtime-config.js";
import {
  createRunEnvelope,
  parseRunEnvelope,
  wsUrlFromHttpBase,
  type ClientMessageType,
  type RunEnvelope,
} from "../shared/run-protocol.js";

export type WsMessageHandler = (envelope: RunEnvelope) => void;

export class MiruWsClient {
  private socket: WebSocket | null = null;
  private handler: WsMessageHandler | null = null;
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private intentionalClose = false;
  private readonly connectionId = crypto.randomUUID();

  setHandler(onMessage: WsMessageHandler): void {
    this.handler = onMessage;
  }

  connect(onMessage: WsMessageHandler): Promise<void> {
    this.handler = onMessage;
    this.intentionalClose = false;

    if (this.isOpen()) {
      return Promise.resolve();
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.openSocket().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  send<T extends ClientMessageType, P>(type: T, runId: string, payload: P): void {
    if (!this.isOpen()) {
      throw new Error("WebSocket is not connected.");
    }
    const envelope = createRunEnvelope(type, runId, payload);
    this.socket!.send(JSON.stringify(envelope));
  }

  sendHello(extensionVersion: string): void {
    if (!this.isOpen()) {
      return;
    }
    const envelope = createRunEnvelope("client.hello", "", {
      extensionVersion,
      connectionId: this.connectionId,
    });
    this.socket!.send(JSON.stringify(envelope));
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = wsUrlFromHttpBase(MIRU_BACKEND_URL);

      // Avoid overlapping handshakes (init + resume both called connect() within ms).
      if (this.socket) {
        const prior = this.socket;
        this.socket = null;
        prior.close();
      }

      const socket = new WebSocket(url);

      socket.addEventListener("open", () => {
        this.socket = socket;
        this.reconnectAttempt = 0;
        this.sendHello(chrome.runtime.getManifest().version);
        resolve();
      });

      socket.addEventListener("message", (event) => {
        const text = typeof event.data === "string" ? event.data : "";
        const envelope = parseRunEnvelope(text);
        if (envelope && this.handler) {
          this.handler(envelope);
        }
      });

      socket.addEventListener("close", () => {
        this.socket = null;
        if (!this.intentionalClose && this.handler) {
          this.scheduleReconnect();
        }
      });

      socket.addEventListener("error", () => {
        if (socket.readyState !== WebSocket.OPEN) {
          reject(new Error(`WebSocket failed to connect to ${url}`));
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.intentionalClose) {
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.handler && !this.intentionalClose) {
        void this.openSocket().catch((error) => {
          console.warn("[Miru] WebSocket reconnect failed:", error);
          this.scheduleReconnect();
        });
      }
    }, delay);
  }
}

export const wsClient = new MiruWsClient();
