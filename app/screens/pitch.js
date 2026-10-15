// «Смисли» — що ми продаємо і як про це говорити (таск 1b128e83, 15.10.2026).
//
// Лідген посеред розмови відкриває картку продукту: кому й коли пропонувати,
// ціна, смисли, пруф, заперечення, чого не обіцяти, що слати в DM. Фразу й
// посилання копіює однією кнопкою. Працюють переважно з ПК, тому зліва список
// продуктів, справа картка; на телефоні — спершу список, тап відкриває картку.
//
// Адміністратор тут же править зміст, додає апдейти (дата ставиться сама),
// посилання, файли й нові продукти. Хто може писати, вирішує сервер
// (`book.canEdit`); кнопки лише це відображають.
//
// Адреса «…/#pitch/<id продукту>» відкриває одразу потрібну картку — щоб
// скинути колезі.

import { api, escapeAttr, escapeHtml, onScreen, refreshIcons } from "../core.js";

onScreen("pitch", { open: () => void openPitch() });

const root = () => document.getElementById("pitchRoot");
const INTRO_FOLD_KEY = "outbound:pitch-intro-folded";
const TONE_LABEL = { priority: "Акцент", low: "Спокійний", exception: "Виняток", muted: "Без кольору" };

let book = null;
let selectedId = "";
let editing = false;
let editingIntro = false;
let reading = false; // на вузькому екрані: показана картка, а не список
let notice = { kind: "", text: "" };
let loadError = "";

async function openPitch() {
  const fromHash = window.location.hash.replace(/^#/, "").split("/");
  if (fromHash[0] === "pitch" && fromHash[1]) {
    selectedId = decodeURIComponent(fromHash[1]);
    reading = true;
  }
  if (!book) drawShell("Завантажую смисли…");
  try {
    book = await api("/api/pitch");
    loadError = "";
  } catch (error) {
    if (error?.name === "AbortError") return;
    loadError = error.message || "Не вдалося завантажити смисли.";
  }
  draw();
}

function drawShell(text) {
  root().innerHTML = `<div class="empty-state">${escapeHtml(text)}</div>`;
}

/* ── формат ─────────────────────────────────────────────────────────────── */

function date(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return `${String(at.getDate()).padStart(2, "0")}.${String(at.getMonth() + 1).padStart(2, "0")}.${at.getFullYear()}`;
}

function bytes(count) {
  if (count >= 1024 * 1024) return `${(count / 1024 / 1024).toFixed(1).replace(".", ",")} МБ`;
  return `${Math.max(1, Math.round(count / 1024))} КБ`;
}

/** **жирне** всередині вже екранованого рядка. */
function inline(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}

/**
 * Текст розділу: рядки, що починаються з «- », стають пунктами списку, решта —
 * абзацами. Так адміністратор пише звичайним текстом, без розмітки.
 */
function richText(text) {
  const out = [];
  let list = [];
  const flush = () => {
    if (list.length) out.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const raw of String(text || "").split("\n")) {
    const lineText = raw.trim();
    if (/^[-•]\s+/.test(lineText)) {
      list.push(lineText.replace(/^[-•]\s+/, ""));
      continue;
    }
    flush();
    if (lineText) out.push(`<p>${inline(lineText)}</p>`);
  }
  flush();
  return out.join("");
}

function stamp(at, by) {
  const when = date(at);
  if (!when) return "";
  return `Оновлено ${when}${by ? ` · ${escapeHtml(by)}` : ""}`;
}

/* ── малювання ──────────────────────────────────────────────────────────── */

function visibleProducts() {
  return book?.products || [];
}

function current() {
  const products = visibleProducts();
  return products.find((product) => product.id === selectedId) || products[0] || null;
}

function introFolded() {
  try { return window.localStorage.getItem(INTRO_FOLD_KEY) === "1"; } catch { return false; }
}

function draw() {
  const host = root();
  if (!host) return;
  if (loadError && !book) {
    host.innerHTML = `<div class="empty-state pitch-error">${escapeHtml(loadError)} <button type="button" data-act="reload">Спробувати ще раз</button></div>`;
    return;
  }
  if (!book) return;
  const product = current();
  if (product) selectedId = product.id;
  host.innerHTML = `
    ${drawIntro()}
    <div class="pitch-layout${reading ? " is-reading" : ""}">
      <aside class="panel pitch-side" aria-label="Продукти">
        <div class="pitch-side-head">
          <h2>Продукти</h2>
          ${book.canEdit ? `<button type="button" class="primary-button pitch-add" data-act="new-product"><i data-lucide="plus"></i><span>Продукт</span></button>` : ""}
        </div>
        ${book.canEdit ? `<form class="pitch-new" data-form="new-product" hidden><input name="name" maxlength="120" placeholder="Назва нового продукту" required /><button type="submit" class="primary-button">Створити</button><button type="button" data-act="cancel-new">Скасувати</button></form>` : ""}
        <nav class="pitch-list">${visibleProducts().map((item, index) => `
          <button type="button" class="pitch-list-item${item.id === selectedId ? " active" : ""}" data-act="select" data-id="${escapeAttr(item.id)}">
            <span class="pitch-list-name">${index + 1} · ${escapeHtml(item.name)}</span>
            <span class="pitch-list-meta">${item.badgeLabel ? `<span class="pitch-badge tone-${escapeAttr(item.badgeTone)}">${escapeHtml(item.badgeLabel)}</span>` : ""}<span>оновл. ${escapeHtml(date(item.updatedAt))}</span></span>
          </button>`).join("") || `<p class="pitch-empty">Продуктів ще немає.</p>`}
        </nav>
      </aside>
      <article class="panel pitch-card" aria-live="polite">
        ${product ? (editing ? drawEditor(product) : drawCard(product)) : `<p class="pitch-empty">Оберіть продукт ліворуч.</p>`}
      </article>
    </div>`;
  refreshIcons(host);
}

function drawIntro() {
  if (!book.intro && !book.canEdit) return "";
  if (editingIntro) {
    return `<section class="panel pitch-intro">
      <form class="pitch-intro-form" data-form="intro">
        <label><span>Як користуватись смислами</span><textarea name="text" rows="6" maxlength="4000">${escapeHtml(book.intro)}</textarea></label>
        <p class="pitch-hint">«- » на початку рядка — пункт списку, **так** — жирний.</p>
        <div class="pitch-actions"><button type="submit" class="primary-button">Зберегти</button><button type="button" data-act="cancel-intro">Скасувати</button></div>
      </form>
    </section>`;
  }
  return `<details class="panel pitch-intro"${introFolded() ? "" : " open"}>
    <summary><span>Як користуватись смислами</span><i data-lucide="chevron-down"></i></summary>
    <div class="pitch-intro-body">
      ${richText(book.intro)}
      ${book.canEdit ? `<button type="button" class="pitch-inline-edit" data-act="edit-intro"><i data-lucide="pencil"></i><span>Редагувати</span></button>` : ""}
    </div>
  </details>`;
}

function copyButton(text, label = "Копіювати") {
  return `<button type="button" class="pitch-copy" data-act="copy" data-copy="${escapeAttr(text)}" title="${escapeAttr(label)}"><i data-lucide="copy"></i><span>${escapeHtml(label)}</span></button>`;
}

function drawCard(product) {
  const index = visibleProducts().indexOf(product) + 1;
  const edit = book.canEdit;
  return `
    <header class="pitch-head">
      <button type="button" class="pitch-back" data-act="back"><i data-lucide="arrow-left"></i><span>Усі продукти</span></button>
      <div class="pitch-title-row">
        <h2>${index} · ${escapeHtml(product.name)}</h2>
        ${product.badgeLabel ? `<span class="pitch-badge tone-${escapeAttr(product.badgeTone)}">${escapeHtml(product.badgeLabel)}</span>` : ""}
      </div>
      ${product.price ? `<p class="pitch-price">${escapeHtml(product.price)}</p>` : ""}
      ${product.pitch ? `<p class="pitch-pitch">${inline(product.pitch)}</p>` : ""}
      <div class="pitch-stamp-row">
        <span class="pitch-stamp">${stamp(product.updatedAt, product.updatedBy)}</span>
        ${edit ? `<button type="button" data-act="edit"><i data-lucide="pencil"></i><span>Редагувати</span></button>` : ""}
      </div>
    </header>
    ${notice.text ? `<p class="pitch-notice ${notice.kind === "error" ? "is-error" : ""}" role="status">${escapeHtml(notice.text)}</p>` : ""}
    <div class="pitch-rows">
      ${product.sections.map((section) => `
        <div class="pitch-row"><span class="pitch-key">${escapeHtml(section.title)}</span><div class="pitch-val">${richText(section.text)}</div></div>`).join("")}
      ${drawLinks(product)}
      ${product.oneLiner ? `
        <div class="pitch-row"><span class="pitch-key">DM one-liner</span>
          <div class="pitch-val"><div class="pitch-oneliner"><p lang="en">${escapeHtml(product.oneLiner)}</p>${copyButton(product.oneLiner)}</div></div>
        </div>` : ""}
      ${drawFiles(product)}
      ${drawUpdates(product)}
    </div>`;
}

function drawLinks(product) {
  const edit = book.canEdit;
  if (!product.links.length && !edit) return "";
  return `
    <div class="pitch-row pitch-row-send"><span class="pitch-key">Що слати в DM</span>
      <div class="pitch-val">
        <ul class="pitch-links">${product.links.map((link) => `
          <li>
            <a href="${escapeAttr(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label || link.url)}</a>
            <span class="pitch-item-actions">${copyButton(link.url, "Копіювати посилання")}${edit ? `<button type="button" class="icon-button" data-act="delete-link" data-id="${escapeAttr(link.id)}" title="Прибрати посилання" aria-label="Прибрати посилання"><i data-lucide="x"></i></button>` : ""}</span>
          </li>`).join("")}
        </ul>
        ${!product.links.length ? `<p class="pitch-empty">Посилань ще немає.</p>` : ""}
        ${edit ? `<form class="pitch-inline-form" data-form="link">
          <input name="label" maxlength="200" placeholder="Підпис: що це і коли слати" />
          <input name="url" type="url" required placeholder="https://…" />
          <button type="submit"><i data-lucide="link"></i><span>Додати посилання</span></button>
        </form>` : ""}
      </div>
    </div>`;
}

function drawFiles(product) {
  const edit = book.canEdit;
  if (!product.files.length && !edit) return "";
  return `
    <div class="pitch-row"><span class="pitch-key">Файли</span>
      <div class="pitch-val">
        <ul class="pitch-files">${product.files.map((file) => `
          <li>
            <a href="/api/pitch/files/${encodeURIComponent(file.id)}" download="${escapeAttr(file.name)}"><i data-lucide="paperclip"></i><span>${escapeHtml(file.name)}</span></a>
            <span class="pitch-file-meta">${bytes(file.bytes)} · ${escapeHtml(date(file.addedAt))}</span>
            ${edit ? `<button type="button" class="icon-button" data-act="delete-file" data-id="${escapeAttr(file.id)}" title="Прибрати файл" aria-label="Прибрати файл"><i data-lucide="x"></i></button>` : ""}
          </li>`).join("")}
        </ul>
        ${!product.files.length ? `<p class="pitch-empty">Файлів ще немає.</p>` : ""}
        ${edit ? `<label class="pitch-upload"><input type="file" data-act="upload" hidden /><span class="pitch-upload-btn"><i data-lucide="upload"></i><span>Прикріпити файл</span></span><span class="pitch-hint">до 20 МБ</span></label>` : ""}
      </div>
    </div>`;
}

function drawUpdates(product) {
  const edit = book.canEdit;
  if (!product.updates.length && !edit) return "";
  return `
    <div class="pitch-row"><span class="pitch-key">Апдейти</span>
      <div class="pitch-val">
        ${edit ? `<form class="pitch-update-form" data-form="update">
          <textarea name="text" rows="2" maxlength="4000" required placeholder="Що змінилось: нова ціна, свіжий кейс, нове заперечення… Дата поставиться сама."></textarea>
          <button type="submit" class="primary-button"><i data-lucide="plus"></i><span>Додати апдейт</span></button>
        </form>` : ""}
        <ol class="pitch-updates">${product.updates.map((update) => `
          <li>
            <span class="pitch-update-when">${escapeHtml(date(update.at))}${update.by ? ` · ${escapeHtml(update.by)}` : ""}</span>
            <div class="pitch-update-text">${richText(update.text)}</div>
            ${edit ? `<button type="button" class="icon-button" data-act="delete-update" data-id="${escapeAttr(update.id)}" title="Прибрати апдейт" aria-label="Прибрати апдейт"><i data-lucide="x"></i></button>` : ""}
          </li>`).join("")}
        </ol>
        ${!product.updates.length ? `<p class="pitch-empty">Апдейтів ще немає.</p>` : ""}
      </div>
    </div>`;
}

function drawEditor(product) {
  const tones = Object.entries(TONE_LABEL).map(([value, label]) => `<option value="${value}"${product.badgeTone === value ? " selected" : ""}>${label}</option>`).join("");
  return `
    <form class="pitch-editor" data-form="product">
      <div class="pitch-editor-head">
        <h2>Редагування</h2>
        <div class="pitch-actions"><button type="submit" class="primary-button"><i data-lucide="check"></i><span>Зберегти</span></button><button type="button" data-act="cancel-edit">Скасувати</button></div>
      </div>
      ${notice.text ? `<p class="pitch-notice ${notice.kind === "error" ? "is-error" : ""}" role="status">${escapeHtml(notice.text)}</p>` : ""}
      <div class="pitch-grid">
        <label><span>Назва</span><input name="name" maxlength="120" required value="${escapeAttr(product.name)}" /></label>
        <label><span>Позначка</span><input name="badgeLabel" maxlength="60" value="${escapeAttr(product.badgeLabel)}" placeholder="Пріоритет, Low-ticket…" /></label>
        <label><span>Колір позначки</span><select name="badgeTone">${tones}</select></label>
      </div>
      <label><span>Ціна й формат</span><input name="price" maxlength="300" value="${escapeAttr(product.price)}" /></label>
      <label><span>Пітч — одна фраза</span><textarea name="pitch" rows="2" maxlength="600">${escapeHtml(product.pitch)}</textarea></label>
      <fieldset class="pitch-sections">
        <legend>Розділи</legend>
        <p class="pitch-hint">«- » на початку рядка — пункт списку, **так** — жирний. Порядок — стрілками.</p>
        <div data-sections>${product.sections.map((section) => sectionEditor(section)).join("")}</div>
        <button type="button" data-act="add-section"><i data-lucide="plus"></i><span>Розділ</span></button>
      </fieldset>
      <label><span>DM one-liner (англійською)</span><textarea name="oneLiner" rows="3" maxlength="1200">${escapeHtml(product.oneLiner)}</textarea></label>
      <p class="pitch-hint">Посилання, файли й апдейти додаються на самій картці, без редагування.</p>
      <div class="pitch-editor-foot">
        <button type="button" class="danger-button" data-act="archive"><i data-lucide="archive"></i><span>Прибрати продукт</span></button>
      </div>
    </form>`;
}

function sectionEditor(section = { id: "", title: "", text: "" }) {
  return `
    <div class="pitch-section-edit" data-section-id="${escapeAttr(section.id)}">
      <div class="pitch-section-bar">
        <input name="sectionTitle" maxlength="80" placeholder="Назва розділу: Кому, Коли, Пруф…" value="${escapeAttr(section.title)}" />
        <button type="button" class="icon-button" data-act="section-up" title="Вище" aria-label="Вище"><i data-lucide="arrow-up"></i></button>
        <button type="button" class="icon-button" data-act="section-down" title="Нижче" aria-label="Нижче"><i data-lucide="arrow-down"></i></button>
        <button type="button" class="icon-button" data-act="section-remove" title="Прибрати розділ" aria-label="Прибрати розділ"><i data-lucide="trash-2"></i></button>
      </div>
      <textarea name="sectionText" rows="4" maxlength="8000">${escapeHtml(section.text)}</textarea>
    </div>`;
}

/* ── дії ─────────────────────────────────────────────────────────────────── */

function setNotice(kind, text) {
  notice = { kind, text };
}

function select(id) {
  if (editing && !window.confirm("Є незбережені зміни. Вийти без збереження?")) return;
  editing = false;
  selectedId = id;
  reading = true;
  setNotice("", "");
  window.history.replaceState(null, "", `#pitch/${encodeURIComponent(id)}`);
  draw();
  // На вузькому екрані картка стоїть під вступом — показуємо її початок, а не середину сторінки.
  if (window.matchMedia("(max-width: 860px)").matches) document.querySelector("#pitchRoot .pitch-card")?.scrollIntoView({ block: "start" });
}

/**
 * Помилка не перемальовує екран: набране в редакторі, апдейті чи посиланні
 * лишається у формі, а повідомлення з'являється поруч. Перемальовка зі стану
 * сервера стерла б те, що людина щойно написала.
 */
function showNoticeInPlace() {
  const card = document.querySelector("#pitchRoot .pitch-card");
  if (!card) return;
  let line = card.querySelector(".pitch-notice");
  if (!line) {
    line = document.createElement("p");
    line.setAttribute("role", "status");
    const anchor = card.querySelector(".pitch-head, .pitch-editor-head");
    if (anchor) anchor.after(line);
    else card.prepend(line);
  }
  line.className = `pitch-notice${notice.kind === "error" ? " is-error" : ""}`;
  line.textContent = notice.text;
}

async function mutate(path, body, okText) {
  try {
    const result = await api(path, { method: "POST", body: JSON.stringify(body || {}) });
    book = result.book || book;
    setNotice(okText ? "ok" : "", okText || "");
    draw();
    return result;
  } catch (error) {
    if (error?.name === "AbortError") return null;
    setNotice("error", error.message || "Не вдалося зберегти.");
    showNoticeInPlace();
    return null;
  }
}

async function copy(text, button) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // Без дозволу на буфер (http, старий браузер) — через тимчасове поле.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    area.remove();
  }
  const label = button.querySelector("span");
  const before = label?.textContent;
  button.classList.add(ok ? "is-copied" : "is-failed");
  if (label) label.textContent = ok ? "Скопійовано" : "Не скопіювалось";
  setTimeout(() => {
    button.classList.remove("is-copied", "is-failed");
    if (label) label.textContent = before;
  }, 1600);
}

function readSections(form) {
  return [...form.querySelectorAll(".pitch-section-edit")].map((row) => ({
    id: row.dataset.sectionId || "",
    title: row.querySelector('[name="sectionTitle"]').value,
    text: row.querySelector('[name="sectionText"]').value
  }));
}

async function upload(input) {
  const file = input.files?.[0];
  const product = current();
  if (!file || !product) return;
  if (file.size > 20 * 1024 * 1024) {
    setNotice("error", `«${file.name}» більший за 20 МБ.`);
    draw();
    return;
  }
  setNotice("ok", `Завантажую «${file.name}»…`);
  draw();
  try {
    // Не через api(): тіло — сам файл, а не JSON.
    const response = await fetch(`/api/pitch/products/${encodeURIComponent(product.id)}/files`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
      body: file
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Не вдалося завантажити (${response.status}).`);
    book = result.book || book;
    setNotice("ok", `Файл «${file.name}» додано.`);
  } catch (error) {
    setNotice("error", error.message || "Не вдалося завантажити файл.");
  }
  draw();
}

document.addEventListener("click", (event) => {
  const target = event.target.closest?.("#pitchRoot [data-act]");
  if (!target) return;
  const act = target.dataset.act;
  const product = current();
  const base = product ? `/api/pitch/products/${encodeURIComponent(product.id)}` : "";

  if (act === "upload") return; // це <input type=file>: діє на change
  if (act === "reload") return void openPitch();
  if (act === "select") return select(target.dataset.id);
  if (act === "back") {
    reading = false;
    window.history.replaceState(null, "", "#pitch");
    return draw();
  }
  if (act === "copy") return void copy(target.dataset.copy || "", target);
  if (act === "new-product") {
    const form = document.querySelector('#pitchRoot [data-form="new-product"]');
    if (form) {
      form.hidden = false;
      form.querySelector("input")?.focus();
    }
    return;
  }
  if (act === "cancel-new") {
    target.closest("form").hidden = true;
    return;
  }
  if (act === "edit-intro") {
    editingIntro = true;
    return draw();
  }
  if (act === "cancel-intro") {
    editingIntro = false;
    return draw();
  }
  if (act === "edit") {
    editing = true;
    setNotice("", "");
    return draw();
  }
  if (act === "cancel-edit") {
    if (!window.confirm("Скасувати зміни в цьому продукті?")) return;
    editing = false;
    setNotice("", "");
    return draw();
  }
  if (act === "add-section") {
    target.closest("fieldset").querySelector("[data-sections]").insertAdjacentHTML("beforeend", sectionEditor());
    refreshIcons(target.closest("fieldset"));
    target.closest("fieldset").querySelector(".pitch-section-edit:last-child input")?.focus();
    return;
  }
  if (["section-up", "section-down", "section-remove"].includes(act)) {
    const row = target.closest(".pitch-section-edit");
    if (act === "section-up" && row.previousElementSibling) row.previousElementSibling.before(row);
    if (act === "section-down" && row.nextElementSibling) row.nextElementSibling.after(row);
    if (act === "section-remove" && window.confirm("Прибрати цей розділ? Зміни запишуться після «Зберегти».")) row.remove();
    return;
  }
  if (act === "archive") {
    if (!window.confirm(`Прибрати «${product.name}» зі «Смислів»? Лідгени більше його не побачать.`)) return;
    editing = false;
    selectedId = "";
    reading = false;
    return void mutate(`${base}/archive`, {}, "Продукт прибрано.");
  }
  if (act === "delete-link" && window.confirm("Прибрати це посилання?")) return void mutate(`${base}/links/${encodeURIComponent(target.dataset.id)}/delete`, {}, "");
  if (act === "delete-file" && window.confirm("Прибрати цей файл?")) return void mutate(`${base}/files/${encodeURIComponent(target.dataset.id)}/delete`, {}, "");
  if (act === "delete-update" && window.confirm("Прибрати цей апдейт?")) return void mutate(`${base}/updates/${encodeURIComponent(target.dataset.id)}/delete`, {}, "");
});

document.addEventListener("change", (event) => {
  const input = event.target.closest?.('#pitchRoot input[data-act="upload"]');
  if (input) void upload(input);
});

// Згорнутий вступ лишається згорнутим: хто його прочитав, тому він більше не потрібен щодня.
document.addEventListener("toggle", (event) => {
  if (!event.target.matches?.("#pitchRoot details.pitch-intro")) return;
  try { window.localStorage.setItem(INTRO_FOLD_KEY, event.target.open ? "0" : "1"); } catch {}
}, true);

document.addEventListener("submit", (event) => {
  const form = event.target.closest?.("#pitchRoot form[data-form]");
  if (!form) return;
  event.preventDefault();
  const kind = form.dataset.form;
  const product = current();
  const base = product ? `/api/pitch/products/${encodeURIComponent(product.id)}` : "";
  const value = (name) => form.querySelector(`[name="${name}"]`)?.value ?? "";

  if (kind === "new-product") {
    return void mutate("/api/pitch/products", { name: value("name") }, "").then((result) => {
      if (!result?.productId) return;
      selectedId = result.productId;
      editing = true;
      reading = true;
      window.history.replaceState(null, "", `#pitch/${encodeURIComponent(selectedId)}`);
      setNotice("ok", "Продукт створено — заповніть картку.");
      draw();
    });
  }
  if (kind === "intro") {
    return void mutate("/api/pitch/intro", { text: value("text") }, "").then((result) => {
      if (!result) return;
      editingIntro = false;
      draw();
    });
  }
  if (kind === "product") {
    const body = {
      name: value("name"), badgeLabel: value("badgeLabel"), badgeTone: value("badgeTone"),
      price: value("price"), pitch: value("pitch"), oneLiner: value("oneLiner"), sections: readSections(form)
    };
    return void mutate(base, body, "Збережено.").then((result) => {
      if (!result) return;
      editing = false;
      draw();
    });
  }
  if (kind === "link") return void mutate(`${base}/links`, { label: value("label"), url: value("url") }, "Посилання додано.");
  if (kind === "update") return void mutate(`${base}/updates`, { text: value("text") }, "Апдейт додано.");
});
