import { LitElement, css, html } from "lit";
import { tokens } from "./theme";

interface Toast {
  id: number;
  text: string;
  error: boolean;
}

/** Short messages drawn by the shell, consistent across skins. */
export class ToastHost extends LitElement {
  static properties = { toasts: { state: true } };
  declare toasts: Toast[];
  private nextId = 1;

  constructor() {
    super();
    this.toasts = [];
  }

  show(text: string, error = false) {
    const t = { id: this.nextId++, text, error };
    this.toasts = [...this.toasts, t].slice(-4);
    setTimeout(() => (this.toasts = this.toasts.filter((x) => x.id !== t.id)), error ? 6000 : 3000);
  }

  render() {
    return html`${this.toasts.map((t) => html`<div class="toast ${t.error ? "error" : ""}" role="status">${t.text}</div>`)}`;
  }

  static styles = [
    tokens,
    css`
      :host {
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        flex-direction: column;
        gap: 8px;
        z-index: 100;
        pointer-events: none;
      }
      .toast {
        background: var(--v-surface-raised);
        color: var(--v-text);
        padding: 10px 16px;
        border-radius: var(--v-radius);
        box-shadow: 0 6px 24px #0008;
        font: 14px var(--v-font-body);
        max-width: 560px;
      }
      .toast.error {
        border-left: 3px solid var(--v-danger);
      }
    `,
  ];
}

customElements.define("vellum-toasts", ToastHost);

let host: ToastHost | null = null;

/** The shell registers its toast host once it has rendered. */
export function registerToasts(h: ToastHost) {
  host = h;
}

export const toasts = () => ({
  show: (text: string, error = false) => (host ? host.show(text, error) : console.info(text)),
});
