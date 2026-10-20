import { css } from "lit";

// Shell tokens: the active skin's colors when it has reported them (applySkinTheme), with
// these defaults whenever a skin is broken or still loading, so settings always stay readable.
export const tokens = css`
  :host {
    --v-bg: var(--skin-bg, #0b0d12);
    --v-surface: var(--skin-surface, #141824);
    --v-surface-raised: var(--skin-surface-raised, #1c2131);
    --v-text: var(--skin-text, #e6e8ee);
    --v-text-muted: var(--skin-text-muted, #9aa3b5);
    --v-accent: var(--skin-accent, #7cc4ff);
    --v-accent-text: var(--skin-accent-text, #06121f);
    --v-focus-ring: var(--skin-focus-ring, #7cc4ff);
    --v-danger: #ff7a7a;
    --v-warning: #f5c76b;
    --v-ok: #6fdc8c;
    --v-radius: var(--skin-radius, 8px);
    --v-gap: 16px;
    --v-font-body: var(--skin-font-body, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif);
    --v-transition: 120ms ease;
  }
`;

/** Applies the active skin's reported tokens (bridge `ui.theme`) to every shell component. */
export function applySkinTheme(tokensFromSkin: Record<string, string>) {
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(tokensFromSkin)) {
    // Fonts the skin bundles don't exist in the shell's document; keep the shell's own.
    if (k === "--v-font-body") continue;
    root.setProperty(k.replace(/^--v-/, "--skin-"), v);
  }
  if (tokensFromSkin["--v-bg"]) document.documentElement.style.background = tokensFromSkin["--v-bg"];
}

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
