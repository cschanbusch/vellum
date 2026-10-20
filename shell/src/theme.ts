import { css } from "lit";

// Default token values. The shell draws settings with the active skin's tokens from Phase 3
// on; until then (and whenever a skin is broken) these keep it readable.
export const tokens = css`
  :host {
    --v-bg: #0b0d12;
    --v-surface: #141824;
    --v-surface-raised: #1c2131;
    --v-text: #e6e8ee;
    --v-text-muted: #9aa3b5;
    --v-accent: #7cc4ff;
    --v-accent-text: #06121f;
    --v-focus-ring: #7cc4ff;
    --v-danger: #ff7a7a;
    --v-warning: #f5c76b;
    --v-ok: #6fdc8c;
    --v-radius: 8px;
    --v-gap: 16px;
    --v-font-body: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
    --v-transition: 120ms ease;
  }
`;

export const controls = css`
  button {
    font: inherit;
    color: var(--v-text);
    background: var(--v-surface-raised);
    border: 1px solid #2b3246;
    border-radius: var(--v-radius);
    padding: 6px 12px;
    cursor: pointer;
    transition: background var(--v-transition);
  }
  button:hover:not(:disabled) {
    background: #262c40;
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  button.primary {
    background: var(--v-accent);
    color: var(--v-accent-text);
    border-color: transparent;
  }
  button:focus-visible,
  input:focus-visible {
    outline: 2px solid var(--v-focus-ring);
    outline-offset: 2px;
  }
`;
