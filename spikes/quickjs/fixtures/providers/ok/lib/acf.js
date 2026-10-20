export function parseAcf(text) {
  const field = (k) => (text.match(new RegExp(String.raw`"${k}"\s+"([^"]*)"`)) || [])[1];
  return { sourceId: field("appid"), title: field("name"), installed: (Number(field("StateFlags")) & 4) !== 0 };
}
