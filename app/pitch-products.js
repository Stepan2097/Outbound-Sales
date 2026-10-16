// Продукти для LinkedIn — картки «Смислів» (WorkSpace, таск f78ffd9a, 16.10.2026).
// Одне джерело для вибору продукту в кампанії й на Головній; старі продукти AI-
// чернеток (advantage-course, AdAction) сюди не потрапляють.

import { api } from "./core.js";

let products = [];
let loading = null;

/** Список читається раз за сесію сторінки; `force` — після правок у «Смислах». */
export function loadPitchProducts({ force = false } = {}) {
  if (loading && !force) return loading;
  loading = api("/api/pitch")
    .then((book) => { products = (book?.products || []).map(({ id, name, badgeLabel }) => ({ id, name, badgeLabel: badgeLabel || "" })); return products; })
    .catch(() => products);
  return loading;
}

export function pitchProducts() {
  return products;
}

export function pitchProductName(id) {
  return products.find((product) => product.id === id)?.name || null;
}
