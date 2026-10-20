export default {
  scan() {
    const names = ["setTimeout", "setInterval", "fetch", "XMLHttpRequest", "require", "process", "std", "os", "WebAssembly"];
    return { games: [], note: names.map((n) => `${n}=${typeof globalThis[n]}`).join(" ") };
  },
};
