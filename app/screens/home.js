// Головна (Марко 19.10): черга пінгів переїхала у LinkedIn → Вхідні → «До роботи»,
// конвеєр нових контактів — у WorkSpace → «Нові контакти». Тут — куди що переїхало.

import { onScreen, refreshIcons } from "../core.js";
import { openTodayBlock } from "./today.js";
import { showNewContacts } from "./workspace.js";

onScreen("home", { open: () => render() });

function render() {
  const root = document.getElementById("homeRoot");
  if (!root) return;
  root.innerHTML = `<section class="panel blk-ref">
    <p>Черга пінгів — у <button type="button" class="text-button" data-home-go="work">Вхідні → До роботи</button>,
    нові контакти — у <button type="button" class="text-button" data-home-go="contacts">WorkSpace → Нові контакти</button>.</p>
  </section>`;
  refreshIcons(root);
}

document.getElementById("homeRoot")?.addEventListener("click", (event) => {
  const go = event.target.closest("[data-home-go]")?.dataset.homeGo;
  if (go === "work") openTodayBlock();
  if (go === "contacts") showNewContacts();
});
