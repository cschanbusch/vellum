// A module on the second scheme (vmod0) must be a separate origin from the skin.
document.getElementById("origin").textContent = location.origin;

(async () => {
  const results = [];
  const add = (check, expected, result, detail = "") => {
    results.push({ check, expected, result, detail: String(detail).slice(0, 200) });
    const li = document.createElement("li");
    li.textContent = `${result === expected ? "PASS" : "FAIL"} ${check}: ${result}`;
    document.getElementById("out").append(li);
  };

  add("module origin differs from skin origin", "yes", location.origin.includes("vmod0") ? "yes" : "no", location.origin);
  try {
    const doc = parent.frames[0].document;
    add("read skin iframe document", "blocked", "readable", doc.title);
  } catch (e) {
    add("read skin iframe document", "blocked", "blocked", e);
  }
  try {
    const r = await fetch("http://skin.localhost/checks.js");
    add("fetch skin origin files", "blocked", "reachable", `status ${r.status}`);
  } catch (e) {
    add("fetch skin origin files", "blocked", "blocked", e);
  }
  try {
    const v = await vellum.call("ping", { msg: "via-bridge-from-module" });
    add("ping through shell bridge", "pong", v.includes("pong") ? "pong" : "no", v);
  } catch (e) {
    add("ping through shell bridge", "pong", "failed", e);
  }
  vellum.report(results);
})();
