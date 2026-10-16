/**
 * LinkedIn's «seen» line, read by the agent as if it were text (власник 16.10:
 * a contact was made in the CRM named «Ким переглянуто: Stanko Milutinovic о
 * 23:25.»). It is LinkedIn saying who saw a message and when — in a name the
 * person is the name inside it; in a message body the line is not the message.
 */

const SEEN_UK = /^(?:ким\s+)?переглянуто:\s*(.+?)\s+о\s+\d{1,2}:\d{2}\.?$/i;
const SEEN_EN = /^(?:seen|viewed|read)\s+by\s+(.+?)\s+at\s+\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?\.?$/i;
const SEEN_LINE = /^[ \t]*(?:(?:ким\s+)?переглянуто:\s*.+?\s+о\s+\d{1,2}:\d{2}\.?|(?:seen|viewed|read)\s+by\s+.+?\s+at\s+\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?\.?)[ \t]*$/gim;

/** «Ким переглянуто: Stanko Milutinovic о 23:25.» → «Stanko Milutinovic»; any other name as it is. */
export function nameFromSeenLine(name) {
  const text = String(name ?? "").replace(/\s+/g, " ").trim();
  const match = SEEN_UK.exec(text) || SEEN_EN.exec(text);
  return match ? match[1].trim() : text;
}

/** A message body without LinkedIn's «seen» lines in it. */
export function withoutSeenLines(body) {
  return String(body ?? "").replace(SEEN_LINE, "").replace(/\n{3,}/g, "\n\n").trim();
}
