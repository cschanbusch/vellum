// Runs the skin grid benchmark twice: native window size, then a 3840x2160 (physical) layout
// scaled down to fit. Collects reports over postMessage and hands them to the backend.
const SKIN_ORIGIN = navigator.userAgent.includes("Windows") ? "http://skin.localhost" : "skin://localhost";
const frame = document.getElementById("skin");
const modes = ["native", "4k"];
const reports = [];

function configure(mode) {
  if (mode === "4k") {
    const w = 3840 / devicePixelRatio, h = 2160 / devicePixelRatio;
    const scale = Math.min(innerWidth / w, innerHeight / h);
    Object.assign(frame.style, { width: `${w}px`, height: `${h}px`, transform: `scale(${scale})` });
  }
  frame.src = `${SKIN_ORIGIN}/index.html?mode=${mode}`;
}

window.addEventListener("message", (e) => {
  if (e.origin !== SKIN_ORIGIN || e.source !== frame.contentWindow || e.data?.type !== "perf-report") return;
  reports.push(e.data.report);
  if (reports.length < modes.length) configure(modes[reports.length]);
  else window.__TAURI__.core.invoke("report", { results: reports });
});

configure(modes[0]);
