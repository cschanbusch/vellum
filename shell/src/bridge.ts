// The shell end of the skin bridge. The skin runs on its own origin with no IPC; everything
// it wants goes through here, and every message is checked: origin, source window,
// protocol version, method allowlist and argument shape.
import { CALL_METHODS, type CallMethod, type ShellMessage, type SkinMessage } from "../../sdk/src/protocol";
import type { Entry, ProviderInfo, UiState } from "../../sdk/src/types";

export interface BridgeHandlers {
  init(): { library: Entry[]; state: UiState; providers: ProviderInfo[] };
  setState(partial: Partial<Pick<UiState, "view" | "selectedId">>): void;
  action(kind: "launch" | "install" | "uninstall" | "openStore", id: string, provider?: string): Promise<void>;
  toast(text: string): void;
  hasEntry(id: string): boolean;
}

const MAX_ID = 300;
const isStr = (v: unknown, max = MAX_ID): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Returns an error message, or null when the arguments are acceptable. */
export function validateCall(method: CallMethod, args: unknown, h: Pick<BridgeHandlers, "hasEntry">): string | null {
  if (!isObj(args)) return "arguments must be an object";
  switch (method) {
    case "state.set": {
      const keys = Object.keys(args);
      if (keys.some((k) => k !== "view" && k !== "selectedId")) return "state.set accepts only view and selectedId";
      if ("view" in args && !isStr(args.view, 64)) return "view must be a short string";
      if ("selectedId" in args && args.selectedId !== null && !isStr(args.selectedId)) return "selectedId must be a string or null";
      return null;
    }
    case "actions.launch":
    case "actions.install":
    case "actions.uninstall":
    case "actions.openStore":
      if (!isStr(args.id)) return "id must be a string";
      if (args.provider !== undefined && !isStr(args.provider, 64)) return "provider must be a string";
      if (!h.hasEntry(args.id)) return `no entry ${args.id}`;
      return null;
    case "ui.toast":
      return isStr(args.text, 300) ? null : "text must be a string of at most 300 characters";
  }
}

export class SkinBridge {
  rejected = 0;
  private readonly onMessage = (e: MessageEvent) => void this.receive(e);

  constructor(
    private frame: HTMLIFrameElement,
    readonly origin: string,
    private h: BridgeHandlers,
  ) {
    window.addEventListener("message", this.onMessage);
  }

  dispose() {
    window.removeEventListener("message", this.onMessage);
  }

  private send(msg: ShellMessage) {
    this.frame.contentWindow?.postMessage(msg, this.origin);
  }

  push(name: "library" | "state" | "providers", data: unknown) {
    this.send({ v: 1, type: "event", name, data } as ShellMessage);
  }

  private reject(reason: string) {
    this.rejected++;
    console.warn(`[bridge] rejected: ${reason}`);
  }

  private async receive(e: MessageEvent) {
    if (e.origin !== this.origin || e.source !== this.frame.contentWindow) return;
    const msg = e.data as SkinMessage;
    if (!isObj(msg) || msg.v !== 1) return this.reject("bad envelope");

    if (msg.type === "hello") {
      this.send({ v: 1, type: "init", ...this.h.init() });
      return;
    }
    if (msg.type !== "call" || typeof msg.id !== "number") return this.reject("unknown message type");
    const reply = (ok: boolean, valueOrError: unknown) =>
      this.send(
        ok
          ? { v: 1, type: "result", id: msg.id, ok: true, value: valueOrError }
          : { v: 1, type: "result", id: msg.id, ok: false, error: String(valueOrError) },
      );
    if (!(CALL_METHODS as readonly string[]).includes(msg.method)) {
      this.reject(`method ${String(msg.method)}`);
      return reply(false, "method not allowed");
    }
    const problem = validateCall(msg.method, msg.args, this.h);
    if (problem) {
      this.reject(problem);
      return reply(false, problem);
    }
    const args = msg.args as Record<string, unknown>;
    try {
      switch (msg.method) {
        case "state.set":
          this.h.setState(args as Partial<UiState>);
          return reply(true, null);
        case "ui.toast":
          this.h.toast(args.text as string);
          return reply(true, null);
        default: {
          const kind = msg.method.slice("actions.".length) as "launch" | "install" | "uninstall" | "openStore";
          await this.h.action(kind, args.id as string, args.provider as string | undefined);
          return reply(true, null);
        }
      }
    } catch (err) {
      return reply(false, err instanceof Error ? err.message : err);
    }
  }
}
