// Helpers and base styles shared by the kit components.

import { css } from "lit";
import type { Entry } from "../types";

/** Base styles for controls inside kit shadow roots; themed only by tokens. */
export const controlStyles = css`
  :host {
    font-family: var(--v-font-body);
    color: var(--v-text);
  }
  * {
    box-sizing: border-box;
  }
  button,
  select,
  input {
    font: inherit;
    color: inherit;
  }
  button {
    display: inline-flex;
    align-items: center;
    gap: 0.4em;
    background: var(--v-surface-raised);
    border: 1px solid color-mix(in srgb, var(--v-text) 12%, transparent);
    border-radius: var(--v-radius);
    padding: 0.4em 0.85em;
    cursor: pointer;
    transition:
      background var(--v-transition),
      border-color var(--v-transition);
  }
  button:hover:not(:disabled) {
    background: color-mix(in srgb, var(--v-surface-raised) 80%, var(--v-text));
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  button.primary {
    background: var(--v-accent);
    color: var(--v-accent-text);
    border-color: transparent;
    font-weight: 600;
  }
  button.primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--v-accent) 85%, white);
  }
  button.ghost {
    background: transparent;
    border-color: transparent;
  }
  :focus-visible {
    outline: 2px solid var(--v-focus-ring);
    outline-offset: 2px;
  }
  [hidden] {
    display: none !important;
  }
`;

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];
export function formatSize(bytes?: number): string {
  if (!bytes) return "";
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < SIZE_UNITS.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${SIZE_UNITS[i]}`;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "Today", "3 days ago", or a date for anything older than a month. */
export function formatWhen(iso: string | null): string {
  if (!iso) return "Never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days < 1) return relative.format(0, "day");
  if (days < 31) return relative.format(-days, "day");
  return dateFormat.format(t);
}

export function releaseYear(e: Entry): string {
  return e.metadata.releaseDate?.slice(0, 4) ?? "";
}

/** Couch mode scales sizes by --v-couch-scale (default 1.25). */
export function couchScale(): number {
  if (!document.documentElement.hasAttribute("data-couch")) return 1;
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--v-couch-scale")) || 1.25;
}

/** A length token in px, read from `el` (so skins can override it per component). */
export function tokenPx(el: Element, name: string, fallback: number): number {
  const raw = getComputedStyle(el).getPropertyValue(name).trim();
  const v = parseFloat(raw);
  if (Number.isNaN(v)) return fallback;
  if (raw.endsWith("rem")) return v * parseFloat(getComputedStyle(document.documentElement).fontSize);
  return v;
}

export function fire<T>(el: Element, type: string, detail: T, cancelable = true): boolean {
  return el.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true, cancelable }));
}
