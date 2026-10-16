// <option>-и продукту для LinkedIn: «Без продукту» і картки «Смислів» (16.10.2026).
// Чиста функція без імпортів — її беруть і екрани, і тести.

export const NO_PRODUCT_LABEL = "Без продукту — AI підбере з каталогу";

export function pitchProductOptions(products, selectedId, escapeAttr, escapeHtml, { emptyLabel = NO_PRODUCT_LABEL } = {}) {
  const options = [`<option value=""${selectedId ? "" : " selected"}>${escapeHtml(emptyLabel)}</option>`];
  for (const product of products || []) {
    const badge = product.badgeLabel ? ` · ${product.badgeLabel.toLowerCase()}` : "";
    options.push(`<option value="${escapeAttr(product.id)}"${product.id === selectedId ? " selected" : ""}>${escapeHtml(product.name + badge)}</option>`);
  }
  if (selectedId && !(products || []).some((product) => product.id === selectedId)) {
    options.push(`<option value="${escapeAttr(selectedId)}" selected>${escapeHtml(selectedId)} · немає в «Смислах»</option>`);
  }
  return options.join("");
}
