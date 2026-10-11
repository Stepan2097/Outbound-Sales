/**
 * The feed's reaction button, in every language an account's LinkedIn is set to.
 *
 * Its aria-label states its own state in words, which makes it both the
 * selector and the proof that a click landed — and makes it a sentence in the
 * interface language. 11.10.2026: Profile 48's LinkedIn turned Ukrainian
 * («Стан кнопки реакції: реакція відсутня»), the English-only selector found
 * no button on the page, and the likes came back 0/2 for two days without a
 * single error. A language goes here, next to the others, never inline.
 */
const LABELS = [
  { button: 'Reaction button state', none: 'no reaction' },
  { button: 'Стан кнопки реакції', none: 'реакція відсутня' },
];

/** Any reaction button, liked or not. */
export const REACTION_BUTTON = LABELS.map(({ button }) => `button[aria-label^="${button}"]`).join(', ');

/** A reaction button nobody has pressed yet. */
export const UNREACTED_BUTTON = LABELS.map(({ button, none }) => `button[aria-label^="${button}"][aria-label*="${none}"]`).join(', ');

/** Whether a reaction button's label still says «no reaction», in any of the languages. */
export function isUnreacted(label) {
  const text = String(label ?? '').toLowerCase();
  return LABELS.some(({ none }) => text.includes(none.toLowerCase()));
}
