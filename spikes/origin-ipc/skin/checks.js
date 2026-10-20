// Each check tries something a hostile skin might do and records what actually happened.
document.getElementById("origin").textContent = location.origin;

const results = [];
async function check(name, expected, fn) {
  let result, detail = "";
  try {
    const timeout = new Promise((r) => setTimeout(() => r(["timeout", "no answer in 4s"]), 4000));
    [result, detail = ""] = await Promise.race([fn(), timeout]);
  } catch (e) {
    result = "threw";
    detail = String(e);
  }
  results.push({ check: name, expected, result, detail: String(detail).slice(0, 200) });
  const li = document.createElement("li");
  li.textContent = `${result === expected ? "PASS" : "FAIL"} ${name}: ${result}`;
  document.getElementById("out").append(li);
}

const blockedFetch = async (url, init) => {
  try {
    const r = await fetch(url, init);
    return ["reachable", `status ${r.status}`];
  } catch (e) {
    return ["blocked", String(e)];
  }
};

(async () => {
  await check("__TAURI_INTERNALS__ injected", "absent", () =>
    ["__TAURI_INTERNALS__" in window ? "present" : "absent"]);
  await check("__TAURI__ global", "absent", () => ["__TAURI__" in window ? "present" : "absent"]);
  await check("chrome.webview (native postMessage channel)", "absent", () =>
    [window.chrome?.webview ? "present" : "absent"]);

  await check("direct invoke via __TAURI_INTERNALS__", "unavailable", async () => {
    if (!window.__TAURI_INTERNALS__) return ["unavailable"];
    try {
      const v = await window.__TAURI_INTERNALS__.invoke("ping", { msg: "DIRECT-FROM-SKIN" });
      return ["SUCCEEDED", v];
    } catch (e) {
      return ["denied", String(e)];
    }
  });

  await check("fetch Tauri IPC endpoint", "blocked", () =>
    blockedFetch("http://ipc.localhost/ping", { method: "POST", body: "{}" }));
  await check("fetch internet", "blocked", () => blockedFetch("https://example.com/"));
  await check("fetch shell origin", "blocked", () => blockedFetch("http://tauri.localhost/shell.js"));

  await check("read parent.document", "blocked", () => {
    try { return ["readable", parent.document.title]; } catch (e) { return ["blocked", String(e)]; }
  });

  await check("inline script runs", "blocked", async () => {
    const s = document.createElement("script");
    s.textContent = "window.__inlineRan = true";
    document.head.append(s);
    await new Promise((r) => setTimeout(r, 50));
    return [window.__inlineRan ? "ran" : "blocked"];
  });
  await check("eval", "blocked", () => {
    try { eval("1"); return ["ran"]; } catch (e) { return ["blocked", String(e)]; }
  });

  await check("SDK served from /__vellum/sdk.js", "yes", () => [window.vellum ? "yes" : "no"]);
  await check("own file served with CSP header", "yes", async () => {
    const r = await fetch("/index.html");
    const csp = r.headers.get("content-security-policy");
    return [r.ok && csp ? "yes" : "no", csp ?? `status ${r.status}`];
  });

  for (const p of ["/%2e%2e/src-tauri/Cargo.toml", "/..%5csrc-tauri%5cCargo.toml", "/..%2fsrc-tauri%2fCargo.toml"]) {
    await check(`traversal ${p}`, "denied", async () => {
      const r = await fetch(p);
      const text = await r.text();
      return [r.ok && text.includes("[package]") ? "LEAKED" : "denied", `status ${r.status}`];
    });
  }

  await check("ping through shell bridge", "pong", async () => {
    const v = await vellum.call("ping", { msg: "via-bridge-from-skin" });
    return [v.includes("pong") ? "pong" : "no", v];
  });
  await check("non-allowlisted method through bridge", "rejected", async () => {
    try { await vellum.call("report", { results: [] }); return ["ACCEPTED"]; }
    catch (e) { return ["rejected", String(e)]; }
  });
  await check("malformed bridge message", "sent", () => {
    parent.postMessage({ hello: "no version field" }, "*");
    return ["sent"];
  });

  await check("navigate top window", "blocked", () => {
    try { top.location.href = location.origin + "/index.html"; return ["navigated?"]; }
    catch (e) { return ["blocked", String(e)]; }
  });

  vellum.report(results);
})();
