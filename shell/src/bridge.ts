// The shell end of the skin bridge. The skin runs on its own origin with no IPC; everything
// it wants goes through here, and every message is checked: origin, source window,
// protocol version, method allowlist and argument shape.
import {
  CALL_METHODS,
  SHELL_COMMANDS,
  THEME_TOKENS,
  type CallMethod,
  type InitData,
  type ShellEvent,
  type ShellMessage,
  type SkinMessage,
} from "../../sdk/src/protocol";
import { ART_KINDS, GROUP_KEYS, SORT_KEYS } from "../../sdk/src/types";

export interface BridgeContext {
  hasEntry(id: string): boolean;
  /** True for views the skin may switch to right now. */
  hasView(id: string): boolean;
}

export interface BridgeHandlers extends BridgeContext {
  init(): InitData;
  /** Runs a validated call; the result is sent back to the skin. */
  call(method: CallMethod, args: Record<string, unknown>): Promise<unknown> | unknown;
}

const MAX_ID = 300;
const isStr = (v: unknown, max = MAX_ID): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrList = (v: unknown, maxItems: number, maxLen: number) =>
  Array.isArray(v) && v.length <= maxItems && v.every((x) => isStr(x, maxLen));
const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 100_000;

const STATE_KEYS = ["view", "selectedId", "query", "filters", "sort", "groupBy"];
const SORTS = SORT_KEYS.flatMap((k) => [k, `-${k}`]);
const KINDS = ["game", "tool", "dlc", "other"];

function validateFilters(f: unknown): string | null {
  if (!isObj(f)) return "filters must be an object";
  for (const [k, v] of Object.entries(f)) {
    switch (k) {
      case "providers":
      case "categories":
        if (!isStrList(v, 200, 200)) return `filters.${k} must be a list of strings`;
        break;
      case "tags":
        if (!isStrList(v, 64, 40)) return "filters.tags must be a list of strings";
        break;
      case "kinds":
        if (!Array.isArray(v) || !v.every((x) => KINDS.includes(x as string))) return "filters.kinds has an unknown kind";
        break;
      case "favorites":
      case "showHidden":
        if (typeof v !== "boolean") return `filters.${k} must be true or false`;
        break;
      default:
        return `unknown filter ${k}`;
    }
  }
  return null;
}

/** Returns an error message, or null when the arguments are acceptable. */
export function validateCall(method: CallMethod, args: unknown, h: BridgeContext): string | null {
  if (!isObj(args)) return "arguments must be an object";
  const entry = () => (!isStr(args.id) ? "id must be a string" : !h.hasEntry(args.id) ? `no entry ${args.id}` : null);
  switch (method) {
    case "state.set": {
      const bad = Object.keys(args).find((k) => !STATE_KEYS.includes(k));
      if (bad) return `state.set cannot change ${bad}`;
      if ("view" in args && !(isStr(args.view, 64) && h.hasView(args.view))) return "view must be the id of an available view";
      if ("selectedId" in args && args.selectedId !== null && !isStr(args.selectedId)) return "selectedId must be a string or null";
      if ("query" in args && !(typeof args.query === "string" && args.query.length <= 200)) return "query must be a string of at most 200 characters";
      if ("sort" in args && !SORTS.includes(args.sort as string)) return "unknown sort";
      if ("groupBy" in args && args.groupBy !== null && !(GROUP_KEYS as readonly string[]).includes(args.groupBy as string)) return "unknown groupBy";
      if ("filters" in args) return validateFilters(args.filters);
      return null;
    }
    case "actions.launch":
    case "actions.install":
    case "actions.uninstall":
    case "actions.openStore":
      if (args.provider !== undefined && !isStr(args.provider, 64)) return "provider must be a string";
      return entry();
    case "actions.toggleFavorite":
      return entry();
    case "actions.setHidden":
      return typeof args.hidden !== "boolean" ? "hidden must be true or false" : entry();
    case "actions.setTags":
      return !isStrList(args.tags, 32, 40) ? "tags must be at most 32 strings of at most 40 characters" : entry();
    case "actions.changeArt":
      return !(ART_KINDS as readonly string[]).includes(args.kind as string) ? "unknown art kind" : entry();
    case "actions.openSettings":
      return args.page !== undefined && !isStr(args.page, 32) ? "page must be a short string" : null;
    case "ui.toast":
      return isStr(args.text, 300) ? null : "text must be a string of at most 300 characters";
    case "ui.contextMenu":
      if (!isNum(args.x) || !isNum(args.y)) return "x and y must be numbers";
      if (args.items !== undefined) {
        const ok =
          Array.isArray(args.items) &&
          args.items.length <= 6 &&
          args.items.every((i) => isObj(i) && isStr(i.id, 32) && isStr(i.label, 48) && (i.disabled === undefined || typeof i.disabled === "boolean"));
        if (!ok) return "items must be at most 6 { id, label, disabled? } with short strings";
      }
      return entry();
    case "ui.theme": {
      if (!isObj(args.tokens)) return "tokens must be an object";
      for (const [k, v] of Object.entries(args.tokens)) {
        if (!(THEME_TOKENS as readonly string[]).includes(k)) return `unknown token ${k}`;
        if (typeof v !== "string" || v.length > 200 || /url\(|expression|[;{}<>]/i.test(v)) return `token ${k} has an unsafe value`;
      }
      return null;
    }
    case "window.minimize":
    case "window.toggleMaximize":
    case "window.close":
    case "window.startDrag":
      return null;
    case "shell.command":
      return (SHELL_COMMANDS as readonly string[]).includes(args.command as string) ? null : "unknown command";
    case "shelves.set": {
      const bad = Object.keys(args).find((k) => k !== "order" && k !== "collapsed");
      if (bad) return `shelves.set cannot change ${bad}`;
      if ("collapsed" in args && !isStrList(args.collapsed, 500, 300)) return "collapsed must be a list of strings";
      if ("order" in args) {
        if (!isObj(args.order)) return "order must be an object";
        for (const [k, v] of Object.entries(args.order)) {
          if (!(GROUP_KEYS as readonly string[]).includes(k) || !isStrList(v, 500, 200)) return "order must map group keys to labels";
        }
      }
      return null;
    }
    case "dev.error":
      return typeof args.message === "string" && args.message.length <= 2000 && (args.stack === undefined || (typeof args.stack === "string" && args.stack.length <= 8000))
        ? null
        : "message must be a string";
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

  push(ev: ShellEvent) {
    this.send({ v: 1, type: "event", ...ev } as ShellMessage);
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
          ? { v: 1, type: "result", id: msg.id, ok: true, value: valueOrError ?? null }
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
    try {
      reply(true, await this.h.call(msg.method, msg.args as Record<string, unknown>));
    } catch (err) {
      reply(false, err instanceof Error ? err.message : err);
    }
  }
}
