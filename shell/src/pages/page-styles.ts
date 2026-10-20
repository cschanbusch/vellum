import { css } from "lit";

/** Shared layout for settings pages. */
export const pageStyles = css`
  h1 {
    font-size: 22px;
    font-weight: 600;
    margin: 0 0 16px;
  }
  h2 {
    font-size: 15px;
    margin: 0 0 8px;
  }
  section {
    background: var(--v-surface);
    border-radius: var(--v-radius);
    padding: 14px 16px;
    margin-bottom: 14px;
  }
  .muted {
    color: var(--v-text-muted);
  }
  .small {
    font-size: 13px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 0;
  }
  .row + .row {
    border-top: 1px solid color-mix(in srgb, var(--v-text) 6%, transparent);
  }
  .row label,
  .row .label {
    flex: 1;
  }
  select,
  input[type="text"] {
    font: inherit;
    color: var(--v-text);
    background: var(--v-surface-raised);
    border: 1px solid #2b3246;
    border-radius: var(--v-radius);
    padding: 5px 8px;
  }
  input[type="range"] {
    width: 200px;
    accent-color: var(--v-accent);
  }
  input[type="checkbox"] {
    width: 18px;
    height: 18px;
    accent-color: var(--v-accent);
  }
  input[type="color"] {
    width: 44px;
    height: 30px;
    padding: 0;
    border: 1px solid #2b3246;
    border-radius: 6px;
    background: transparent;
  }
  code {
    font-family: ui-monospace, "Cascadia Mono", monospace;
    font-size: 13px;
    word-break: break-all;
  }
  .error {
    color: var(--v-danger);
  }
`;
