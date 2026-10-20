// Shell side of the bridge: the only page with Tauri IPC. Validates every message.
const isWindows = navigator.userAgent.includes("Windows");
const originFor = (scheme) => (isWindows ? `http://${scheme}.localhost` : `${scheme}://localhost`);
const FRAMES = {
  skin: { el: document.getElementById("skin"), origin: originFor("skin") },
  module: { el: document.getElementById("module"), origin: originFor("vmod0") },
};
const ALLOWED_METHODS = { ping: (args) => typeof args?.msg === "string" && args.msg.length < 200 };

const invoke = window.__TAURI__.core.invoke;
const logEl = document.getElementById("log");
const log = (s) => { logEl.textContent += s + "\n"; };
const results = [];
const reported = new Set();
let rejected = 0;

document.getElementById("origin").textContent = location.origin;

function addResults(from, list) {
  const tbody = document.getElementById("results");
  for (const r of list) {
    results.push({ from, ...r });
    const tr = document.createElement("tr");
    const pass = r.result === r.expected;
    for (const v of [from, r.check, r.expected, r.result, r.detail ?? ""]) {
      const td = document.createElement("td");
      td.textContent = v;
      tr.append(td);
    }
    tr.className = pass ? "pass" : "fail";
    tbody.append(tr);
  }
}

function frameFor(event) {
  for (const [name, f] of Object.entries(FRAMES)) {
    if (event.origin === f.origin && event.source === f.el.contentWindow) return name;
  }
  return null;
}

window.addEventListener("message", async (event) => {
  const from = frameFor(event);
  const msg = event.data;
  if (!from || typeof msg !== "object" || msg === null || msg.v !== 1) {
    rejected++;
    log(`REJECTED message from origin=${event.origin}`);
    return;
  }
  const reply = (body) => event.source.postMessage({ v: 1, ...body }, FRAMES[from].origin);

  if (msg.type === "call") {
    const check = ALLOWED_METHODS[msg.method];
    if (!check || !check(msg.args)) {
      rejected++;
      log(`REJECTED call ${from}.${msg.method}`);
      reply({ type: "result", id: msg.id, ok: false, error: "not allowed" });
      return;
    }
    try {
      const value = await invoke(msg.method, msg.args);
      log(`${from} -> ${msg.method}(${JSON.stringify(msg.args)}) = ${value}`);
      reply({ type: "result", id: msg.id, ok: true, value });
    } catch (e) {
      reply({ type: "result", id: msg.id, ok: false, error: String(e) });
    }
  } else if (msg.type === "report" && Array.isArray(msg.results)) {
    addResults(from, msg.results);
    reported.add(from);
    if (reported.size === Object.keys(FRAMES).length) finish();
  }
});

async function finish() {
  // Give a skin top-navigation attempt time to (not) take effect.
  await new Promise((r) => setTimeout(r, 1500));
  addResults("shell", [
    { check: "shell still on its own origin (top-nav blocked)", expected: "yes",
      result: location.origin === window.__SHELL_ORIGIN ? "yes" : "no", detail: location.href },
    { check: "invalid bridge messages rejected", expected: "yes",
      result: rejected > 0 ? "yes" : "no", detail: `${rejected} rejected` },
  ]);
  await invoke("report", { results });
}

window.__SHELL_ORIGIN = location.origin;
FRAMES.skin.el.src = `${FRAMES.skin.origin}/index.html`;
FRAMES.module.el.src = `${FRAMES.module.origin}/index.html`;
