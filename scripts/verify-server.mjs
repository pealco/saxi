import assert from "node:assert/strict";

const base = new URL(process.argv[2] ?? "http://127.0.0.1/");
const response = await fetch(base, { signal: AbortSignal.timeout(10000) });
assert.equal(response.status, 200);
const html = await response.text();
assert.match(html, /saxi/i);
const assets = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g)];
assert.ok(assets.length > 0);
for (const [, filename] of assets) {
  const url = new URL(filename, base);
  assert.equal(url.origin, base.origin);
  const asset = await fetch(url, { signal: AbortSignal.timeout(10000) });
  assert.equal(asset.status, 200);
  assert.ok((await asset.arrayBuffer()).byteLength > 0);
}
const status = await fetch(new URL("/plot/status", base), { signal: AbortSignal.timeout(10000) });
assert.equal(status.status, 200);
assert.deepEqual(await status.json(), { plotting: false });
const presets = await fetch(new URL("/presets", base), { signal: AbortSignal.timeout(10000) });
assert.equal(presets.status, 200);
assert.ok(Array.isArray(await presets.json()));

await new Promise((resolve, reject) => {
  const url = new URL("/chat", base);
  url.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url);
  let device = false;
  let pong = false;
  const timeout = setTimeout(() => finish(new Error("WebSocket timed out")), 10000);
  const finish = error => {
    clearTimeout(timeout);
    ws.close();
    if (error) reject(error);
    else resolve();
  };
  ws.addEventListener("open", () => ws.send(JSON.stringify({ c: "ping" })));
  ws.addEventListener("error", () => finish(new Error("WebSocket connection failed")));
  ws.addEventListener("message", event => {
    try {
      const message = JSON.parse(event.data);
      if (message.c === "dev") {
        assert.equal(typeof message.p.hardware, "string");
        device = true;
      }
      if (message.c === "pong") pong = true;
      if (device && pong) finish();
    } catch (error) { finish(error); }
  });
});
console.log(`HTTP, assets, presets and WebSocket checks passed at ${base}`);
