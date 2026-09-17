/**
 * A profile's platform, derived exactly as Anty derives it.
 *
 * Anty stores no type column: its renderer reads the start page and the tags.
 * This mirrors that rule, because the moment the two disagree a profile is
 * LinkedIn in one app and not in the other, and nobody can tell which is lying.
 */
export const PLATFORMS = ["linkedin", "facebook", "instagram", "other"];

export const PLATFORM_LABEL = {
  linkedin: "LinkedIn",
  facebook: "Facebook",
  instagram: "Instagram",
  other: "Other"
};

/** Tags come back as plain strings or as { name } objects; Anty accepts both. */
export function tagNames(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((entry) =>
      entry && typeof entry === "object"
        ? String(entry.name ?? "").trim().toLowerCase()
        : String(entry ?? "").trim().toLowerCase()
    )
    .filter(Boolean);
}

export function platformOf(profile = {}) {
  const startPage = String(profile.start_page ?? "").toLowerCase();
  const names = tagNames(profile.tags);
  if (startPage.includes("instagram.com") || names.some((tag) => tag.includes("instagram") || tag === "ig")) return "instagram";
  if (startPage.includes("linkedin.com") || names.some((tag) => tag.includes("linkedin") || tag === "li")) return "linkedin";
  if (startPage.includes("facebook.com") || names.some((tag) => tag.includes("facebook") || tag === "fb")) return "facebook";
  return "other";
}

const PLATFORM_TAG = { linkedin: "linkedin", facebook: "facebook", instagram: "instagram" };
const PLATFORM_TAG_PATTERN = /^(linkedin|li|facebook|fb|instagram|ig)$/;

/**
 * Re-tag a profile for a platform. Only platform tags are touched — a profile
 * tagged "ban" or "bm" keeps them, because those are somebody's working notes.
 *
 * Returns a conflict when the start page already decides the platform and
 * disagrees: writing a tag there would produce a profile that claims one thing
 * and behaves as another.
 */
export function retag(profile, platform) {
  const startPage = String(profile.start_page ?? "").toLowerCase();
  const fromStartPage = startPage.includes("instagram.com") ? "instagram"
    : startPage.includes("linkedin.com") ? "linkedin"
    : startPage.includes("facebook.com") ? "facebook"
    : null;

  if (fromStartPage && fromStartPage !== platform) return { conflict: fromStartPage };

  const kept = tagNames(profile.tags).filter((tag) => !PLATFORM_TAG_PATTERN.test(tag));
  if (platform === "other") return { tags: kept };
  return { tags: [...kept, PLATFORM_TAG[platform]] };
}

/**
 * Read back the one-line proxy the table shows.
 *
 * Hand-rolled rather than `new URL()`: proxy passwords routinely contain
 * characters URL parsing either rejects or silently decodes, and a password
 * that changes on a round trip is a proxy that stops working for no visible
 * reason. Returns a message instead of throwing — the caller shows it to
 * whoever typed.
 */
export function parseProxy(input) {
  const raw = String(input || "").trim();
  if (!raw) return { error: "empty" };

  let rest = raw;
  let type = "http";
  const scheme = rest.match(/^([a-z0-9]+):\/\//i);
  if (scheme) {
    type = scheme[1].toLowerCase();
    rest = rest.slice(scheme[0].length);
  }
  if (!["http", "https", "socks5", "socks4"].includes(type)) return { error: `Невідомий тип проксі "${type}"` };

  let username;
  let password;
  // Split on the LAST @: a password may contain one, a hostname may not.
  const at = rest.lastIndexOf("@");
  if (at !== -1) {
    const credentials = rest.slice(0, at);
    rest = rest.slice(at + 1);
    const colon = credentials.indexOf(":");
    username = colon === -1 ? credentials : credentials.slice(0, colon);
    password = colon === -1 ? undefined : credentials.slice(colon + 1);
    if (!username) return { error: "Перед двокрапкою немає імені користувача" };
  }

  const colon = rest.lastIndexOf(":");
  if (colon === -1) return { error: "Немає порту — очікується host:port" };
  const host = rest.slice(0, colon).trim();
  const port = Number(rest.slice(colon + 1).trim());
  if (!host) return { error: "Немає хоста" };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "Порт має бути числом від 1 до 65535" };

  return { type, host, port, ...(username ? { username } : {}), ...(password ? { password } : {}) };
}

export function proxyString(proxy) {
  const type = proxy.type || "http";
  const auth = proxy.username ? `${proxy.username}${proxy.password ? `:${proxy.password}` : ""}@` : "";
  return `${type}://${auth}${proxy.host}${proxy.port ? `:${proxy.port}` : ""}`;
}
