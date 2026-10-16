import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listeningOrigin } from "./server-origin.mjs";

// Таск d1d127d3 (16.10): сервер, запущений тестом (PORT=0), слухає лише 127.0.0.1 —
// інакше кожен прогін npm test на macOS засипає вікнами брандмауера.

const reachable = (host, port) => new Promise((resolve) => {
  const socket = connect({ host, port });
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
  socket.setTimeout(1500, () => { socket.destroy(); resolve(false); });
});

test("сервер із тестів слухає лише 127.0.0.1, а не всі інтерфейси", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "outbound-listen-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, PORT: "0", STATE_FILE_PATH: join(dir, "state.json"), WARMUP_SCHEDULER_DISABLED: "1" };
  delete env.LISTEN_HOST;
  const child = spawn(process.execPath, ["server.mjs"], { cwd: new URL("..", import.meta.url), env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  const origin = await listeningOrigin(child);
  const port = Number(new URL(origin).port);

  assert.equal(await reachable("127.0.0.1", port), true, "на 127.0.0.1 сервер відповідає");
  const outside = Object.values(networkInterfaces()).flat().find((item) => item && item.family === "IPv4" && !item.internal);
  if (outside) assert.equal(await reachable(outside.address, port), false, `на ${outside.address} сервер не слухає`);
});

test("прод і локальний запуск зі справжнім портом слухають як раніше — усі інтерфейси", async () => {
  const { readFile } = await import("node:fs/promises");
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /const listenHost = process\.env\.LISTEN_HOST \|\| \(port === 0 \? "127\.0\.0\.1" : undefined\);/);
  assert.match(server, /server\.listen\(port, listenHost,/);
});
