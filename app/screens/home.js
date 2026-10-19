// Головна (власник 19.10, вибрав «1» з трьох скрінів): як до 16.10 — лише нові
// контакти: папка CRM → людина за людиною → лист чи повідомлення. Той самий
// конвеєр, що у WorkSpace → «Нові контакти» (workspace.js, home-triage.js), тут —
// завжди відкритий, без умови «спершу розмови». Пінги «Сьогодні» — у Вхідних.

import { onScreen } from "../core.js";
import { openNewContactsOnHome } from "./workspace.js";

onScreen("home", { open: () => void openNewContactsOnHome({ gate: false }) });
