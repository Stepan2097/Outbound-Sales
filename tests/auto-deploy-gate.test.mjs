import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// ops/outbound-auto-deploy деплоїть кожен коміт у main. Тепер — лише після
// зеленого npm test саме цього коміту. Тут скрипт запускається справжнім
// bash, а git, docker, curl і logger підмінено заглушками, що пишуть, що з
// ними робили.

const script = new URL("../ops/outbound-auto-deploy", import.meta.url).pathname;
// Тести самого деплою на сервері йдуть у node:20-alpine, де bash немає;
// там цей файл пропускається, а не валить кожен деплой.
const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
const sha = "a".repeat(40);

async function harness({ testExit = 0, testOutput = "ℹ pass 3\nℹ fail 0\n", headAfterTests = sha } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "outbound-deploy-gate-"));
  const bin = join(dir, "bin");
  const calls = join(dir, "calls.log");
  await writeFile(calls, "");
  const stub = async (name, body) => {
    await writeFile(join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> ${JSON.stringify(calls)}\n${body}\n`);
    await chmod(join(bin, name), 0o755);
  };
  await (await import("node:fs/promises")).mkdir(bin);
  await writeFile(join(dir, "lsremote-count"), "0");
  await stub("git", `
case "$1" in
  ls-remote)
    n=$(cat ${JSON.stringify(join(dir, "lsremote-count"))}); echo $((n+1)) > ${JSON.stringify(join(dir, "lsremote-count"))}
    if [ "$n" -ge 1 ]; then echo "${headAfterTests} refs/heads/main"; else echo "${sha} refs/heads/main"; fi ;;
  clone) mkdir -p "\${@: -1}" ;;
  -C) echo "${sha}" ;;
esac`);
  await stub("docker", `
case "$1" in
  ps) if [[ "$*" == *"--filter"* ]]; then echo "coolify-client-1"; fi ;;
  inspect) echo "COOLIFY_TOKEN=test-token" ;;
  run) printf '%b' ${JSON.stringify(testOutput)}; exit ${testExit} ;;
esac`);
  await stub("curl", `echo 200`);
  await stub("logger", `true`);
  // На сервері flock є (/usr/bin/flock); тут — лише щоб скрипт пішов далі.
  await stub("flock", `true`);
  const run = () => spawnSync("bash", [script], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OUTBOUND_DEPLOY_STATE_DIR: join(dir, "state"), OUTBOUND_DEPLOY_LOCK_FILE: join(dir, "deploy.lock") },
    encoding: "utf8"
  });
  return {
    run,
    calls: async () => (await readFile(calls, "utf8")).split("\n").filter(Boolean),
    journal: async () => (await readFile(calls, "utf8")).split("\n").filter((line) => line.startsWith("logger ")).join("\n"),
    state: (name) => readFile(join(dir, "state", name), "utf8"),
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

test("a green commit is tested and then deployed, as before", { skip: !hasBash && "no bash in this image" }, async () => {
  const h = await harness();
  try {
    const result = h.run();
    assert.equal(result.status, 0, result.stderr);
    const calls = await h.calls();
    const testRun = calls.findIndex((line) => line.startsWith("docker run"));
    const deploy = calls.findIndex((line) => line.startsWith("curl") && line.includes("/api/v1/deploy"));
    assert.ok(testRun >= 0, "npm test ran");
    assert.ok(calls[testRun].includes("node:20-alpine") && calls[testRun].includes("npm test"));
    assert.ok(deploy > testRun, "deploy only after the tests");
    assert.equal((await h.state("tested-sha")).trim(), `${sha} green`);
  } finally {
    await h.cleanup();
  }
});

test("a red commit is not deployed and the journal says why", { skip: !hasBash && "no bash in this image" }, async () => {
  const h = await harness({ testExit: 1, testOutput: "not ok 3 - login refuses wrong password\nℹ fail 1\n" });
  try {
    const result = h.run();
    assert.notEqual(result.status, 0);
    const calls = await h.calls();
    assert.equal(calls.some((line) => line.startsWith("curl")), false, "Coolify was not called");
    const journal = await h.journal();
    assert.match(journal, /Tests are red for a{40}.*NOT deploying/);
    assert.match(journal, /not ok 3 - login refuses wrong password/);
    assert.equal((await h.state("tested-sha")).trim(), `${sha} red`);

    // Наступний тік таймера той самий червоний коміт не ганяє й не деплоїть.
    const again = h.run();
    assert.equal(again.status, 0);
    const after = await h.calls();
    assert.equal(after.filter((line) => line.startsWith("docker run")).length, 1);
    assert.equal(after.some((line) => line.startsWith("curl")), false);
  } finally {
    await h.cleanup();
  }
});

test("a commit pushed while tests ran is not deployed untested", { skip: !hasBash && "no bash in this image" }, async () => {
  const h = await harness({ headAfterTests: "b".repeat(40) });
  try {
    const result = h.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await h.calls()).some((line) => line.startsWith("curl")), false);
    assert.match(await h.journal(), /main moved to b{40} during tests/);
  } finally {
    await h.cleanup();
  }
});
