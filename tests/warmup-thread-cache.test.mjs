import assert from "node:assert/strict";
import test from "node:test";

/**
 * Власник 17.11: «всі сторінки і дані мають кешуватися для того щоб весь інтерфейс літав».
 * Важкі відповіді лежать між запитами (state/answer-cache.mjs): свій запис людини — завжди свіже;
 * записи агентів — збережене одразу, свіже за ним; без змін — збережене до ttl.
 */
test("відповідь лежить; запис людини — свіжа; запис у базу (агент) — збережена одразу, свіжа за нею", async () => {
  process.env.ANSWER_CACHE_IN_TESTS = "1";
  try {
    const { cachedAnswer, noteWrite } = await import("../state/answer-cache.mjs");
    const { anty } = await import("../warmup/db.mjs");
    let made = 0;
    const make = async () => { made += 1; return { n: made }; };
    assert.deepEqual(await cachedAnswer("k", make), { n: 1 });
    assert.deepEqual(await cachedAnswer("k", make), { n: 1 }, "друге питання — з пам'яті");
    assert.equal(made, 1);
    // Запис людини: наступна відповідь — нова, не та, що була до її зміни.
    noteWrite();
    assert.deepEqual(await cachedAnswer("k", make), { n: 2 });
    // Запис агента в базу: збережене віддається одразу, нове робиться за ним.
    const previous = { url: process.env.ANTY_SUPABASE_URL, key: process.env.ANTY_SERVICE_ROLE_KEY, fetch: globalThis.fetch };
    process.env.ANTY_SUPABASE_URL = "http://anty.test";
    process.env.ANTY_SERVICE_ROLE_KEY = "k";
    globalThis.fetch = async () => new Response(null, { status: 201 });
    try {
      await anty.from("wl_events").insert({ type: "agent.log" }).rows();
    } finally {
      globalThis.fetch = previous.fetch;
      if (previous.url === undefined) delete process.env.ANTY_SUPABASE_URL; else process.env.ANTY_SUPABASE_URL = previous.url;
      if (previous.key === undefined) delete process.env.ANTY_SERVICE_ROLE_KEY; else process.env.ANTY_SERVICE_ROLE_KEY = previous.key;
    }
    assert.deepEqual(await cachedAnswer("k", make), { n: 2 }, "одразу — збережене");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(await cachedAnswer("k", make), { n: 3 }, "за ним — свіже");
    // Помилка не лишається в пам'яті.
    await assert.rejects(cachedAnswer("bad", async () => { throw new Error("down"); }));
    assert.deepEqual(await cachedAnswer("bad", async () => "ok"), "ok");
  } finally {
    delete process.env.ANSWER_CACHE_IN_TESTS;
  }
});

test("відповідь, що зависла, не тримає всіх: за 15 с наступний питає сам (17.11: «досі завантажується»)", async () => {
  process.env.ANSWER_CACHE_IN_TESTS = "1";
  const realNow = Date.now;
  try {
    const { cachedAnswer } = await import("../state/answer-cache.mjs");
    let now = realNow();
    Date.now = () => now;
    const hung = cachedAnswer("hang", () => new Promise(() => {}));
    let settled = false;
    hung.then(() => { settled = true; });
    // Поки свіжа — спільна.
    let other = 0;
    void cachedAnswer("hang", async () => { other += 1; return "other"; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(other, 0, "поки свіжа — нова не робиться");
    now += 16_000;
    assert.equal(await cachedAnswer("hang", async () => "fresh"), "fresh");
    assert.equal(settled, false);
  } finally {
    Date.now = realNow;
    delete process.env.ANSWER_CACHE_IN_TESTS;
  }
});
