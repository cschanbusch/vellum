// Minimal SDK for the spike: served from the exe at /__vellum/sdk.js on every skin/module origin.
(() => {
  let nextId = 1;
  const pending = new Map();

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return; // only the shell may answer
    const msg = event.data;
    if (msg?.v !== 1 || msg.type !== "result" || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.ok ? resolve(msg.value) : reject(new Error(msg.error));
  });

  const post = (body) => window.parent.postMessage({ v: 1, ...body }, "*");

  window.vellum = {
    call(method, args) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        post({ type: "call", id, method, args });
      });
    },
    report(results) {
      post({ type: "report", results });
    },
  };
})();
