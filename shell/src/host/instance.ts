// The app's one skin host, shared by the library view and the settings pages.
import { SkinHostController, type HostUi } from "./controller";
import { tauriBackend } from "./tauri-backend";

/** Tauri maps the `skin` scheme to http://skin.localhost on Windows. */
export const SKIN_ORIGIN = navigator.userAgent.includes("Windows") ? "http://skin.localhost" : "skin://localhost";

/** Filled in by the shell once its overlays exist. */
export const hostUi: HostUi = {
  toast: (t) => console.info(t),
  contextMenu: () => {},
  openSettings: () => {},
  changeArt: () => {},
  theme: () => {},
  devError: (m) => console.error(m),
  skinFailed: (r) => console.error(r),
};

export const host = new SkinHostController(tauriBackend(SKIN_ORIGIN), hostUi);
