import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Головна (власник 19.10, вибрав «1» з трьох скрінів): як до 16.10 — лише нові
// контакти з листами, без пульта й без умови «спершу розмови». Пульт (7f4471a)
// знято; пінги «Сьогодні» — у Вхідних → «До роботи».

const home = readFileSync(new URL("../app/screens/home.js", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../app/screens/workspace.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");

test("Головна — лише конвеєр нових контактів, відкритий завжди", () => {
  assert.match(home, /openNewContactsOnHome\(\{ gate: false \}\)/);
  const start = html.indexOf('id="view-home"');
  const view = html.slice(start, html.indexOf("</section>", start));
  assert.match(view, /id="homeContacts"/);
  assert.doesNotMatch(view, /homeRoot|todayRoot/, "ні пульта, ні черги пінгів");
});

test("у WorkSpace той самий конвеєр і далі — з умовою «спершу розмови»", () => {
  assert.match(workspace, /gate = useGate \? await api\("\/api\/today\/gate"\) : null/);
  assert.match(workspace, /function openTab\(\) \{\n  placeContactsPane\(null\);/);
});
