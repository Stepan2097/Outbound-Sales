/**
 * A small PostgREST client, standing in for @supabase/supabase-js.
 *
 * Outbound Sales ships with no dependencies — the image copies server.mjs and
 * never runs an install — so the warm-up cannot bring supabase-js with it. Only
 * the subset the warm-up actually uses is here, with the same chained shape at
 * the call sites so the ported queries read like the originals.
 */

export class RestError extends Error {
  constructor(message, { code = null, status = 0, details = null } = {}) {
    super(message);
    this.name = "RestError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Filter values go through as they are, and URL encoding does the whole job.
 *
 * PostgREST's own documentation says a value carrying a reserved character
 * should be double-quoted, but the build behind Supabase passes those quotes
 * down to Postgres rather than stripping them: `country=eq."United States"`
 * matches nobody and a quoted uuid comes back as a type error. Only the first
 * dot after the column separates the operator from the value, so spaces,
 * commas, dots and parentheses inside a value need nothing done to them.
 *
 * The one place that is not so is a list — `in.(a,b)` — which PostgREST parses
 * itself; see `listValue`.
 */
function filterValue(value) {
  return value === null || value === undefined ? "null" : String(value);
}

/**
 * One value inside `in.(…)`, quoted when it has to be.
 *
 * PostgREST reads a list by its own grammar, not Postgres's: an unquoted
 * element runs to the next `,` or `)`, and a double-quoted one runs to its
 * closing quote, with a backslash escaping the next character. Unlike the
 * single values above, those quotes are the parser's and never reach Postgres.
 * Every value used to go in bare on the belief that callers only ever passed
 * uuids — and then a LinkedIn message URN, `urn:li:msg_message:(urn:li:
 * fsd_profile:ACoAA…,2-MTY5…)`, went into the inbox's duplicate check, was cut
 * at its comma, matched nothing, and the whole thread was stored and copied to
 * the CRM again on every read.
 *
 * Quoted only when the bare form would be misread, so a uuid, a date or a type
 * name reaches the server exactly as it always has.
 */
export function listValue(value) {
  const text = filterValue(value);
  if (text !== "" && !/[,()"\\]/.test(text) && text.trim() === text) return text;
  return `"${text.replace(/[\\"]/g, "\\$&")}"`;
}

/**
 * Text made literal inside an `ilike` pattern.
 *
 * Postgres reads `%` and `_` in a LIKE pattern as wildcards and `\` as the
 * escape, so each is escaped. PostgREST turns every `*` into `%` before
 * Postgres sees it, which leaves no way to ask for a literal `*` — it becomes
 * `_`, any one character, and whoever compares the rows afterwards decides.
 * A percent-encoded Cyrillic slug is the case this is for: unescaped, every
 * `%D0` in it was a wildcard, the pattern matched page after page of other
 * people's encoded links, and the real contact fell off the end of the page.
 */
export function likeLiteral(value) {
  return String(value ?? "").replace(/[\\%_]/g, "\\$&").replace(/\*/g, "_");
}

class Query {
  constructor(client, table) {
    this.client = client;
    this.table = table;
    this.params = new URLSearchParams();
    this.headers = {};
    this.method = "GET";
    this.payload = undefined;
    this.wantsReturn = false;
  }

  select(columns = "*") {
    this.params.set("select", columns);
    if (this.method !== "GET") this.wantsReturn = true;
    return this;
  }

  eq(column, value) {
    this.params.append(column, `eq.${filterValue(value)}`);
    return this;
  }

  neq(column, value) {
    this.params.append(column, `neq.${filterValue(value)}`);
    return this;
  }

  in(column, values) {
    this.params.append(column, `in.(${(values || []).map(listValue).join(",")})`);
    return this;
  }

  /** Everything except these. Quoted the way `in` is. */
  notIn(column, values) {
    this.params.append(column, `not.in.(${(values || []).map(listValue).join(",")})`);
    return this;
  }

  /**
   * Case-insensitive match. `*` is the wildcard, and so are `%` and `_`: a
   * value built from data goes through `likeLiteral` first.
   */
  ilike(column, value) {
    this.params.append(column, `ilike.${filterValue(value)}`);
    return this;
  }

  isNull(column) {
    this.params.append(column, "is.null");
    return this;
  }

  notNull(column) {
    this.params.append(column, "not.is.null");
    return this;
  }

  gte(column, value) {
    this.params.append(column, `gte.${filterValue(value)}`);
    return this;
  }

  lt(column, value) {
    this.params.append(column, `lt.${filterValue(value)}`);
    return this;
  }

  /** Raw PostgREST `or=(a.ilike.*x*,b.ilike.*x*)` — the caller builds the clause. */
  or(clause) {
    this.params.append("or", `(${clause})`);
    return this;
  }

  /**
   * A second `order` call is a tie-break, as it is in supabase-js: the terms
   * join into one `order=a.desc,b.asc`. Two separate `order` parameters are not
   * that — PostgREST reads one of them — and paging with OFFSET over a column
   * full of ties (a folder imported in one statement shares one `created_at`)
   * then hands the same row to two pages and skips another.
   */
  order(column, { ascending = true, nullsFirst = null, foreignTable = null } = {}) {
    const direction = ascending ? "asc" : "desc";
    const nulls = nullsFirst === null ? "" : nullsFirst ? ".nullsfirst" : ".nullslast";
    const key = foreignTable ? `${foreignTable}.order` : "order";
    const term = `${column}.${direction}${nulls}`;
    const existing = this.params.get(key);
    this.params.set(key, existing ? `${existing},${term}` : term);
    return this;
  }

  limit(count, { foreignTable = null } = {}) {
    this.params.set(foreignTable ? `${foreignTable}.limit` : "limit", String(count));
    return this;
  }

  /**
   * Skip the first rows. PostgREST does this server-side, which is the point:
   * paging a folder of twenty-two thousand people by fetching and slicing would
   * carry the whole folder to page two.
   */
  offset(count) {
    if (Number(count) > 0) this.params.set("offset", String(Math.trunc(Number(count))));
    return this;
  }

  insert(values) {
    this.method = "POST";
    this.payload = values;
    return this;
  }

  update(patch) {
    this.method = "PATCH";
    this.payload = patch;
    return this;
  }

  remove() {
    this.method = "DELETE";
    return this;
  }

  async #fetch() {
    const config = this.client.config();
    const url = `${config.url}/rest/v1/${this.table}${this.params.toString() ? `?${this.params}` : ""}`;

    const prefer = [];
    if (this.method !== "GET" && this.wantsReturn) prefer.push("return=representation");
    if (this.method !== "GET" && !this.wantsReturn) prefer.push("return=minimal");

    const response = await fetch(url, {
      method: this.method,
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        Accept: "application/json",
        ...(this.payload === undefined ? {} : { "Content-Type": "application/json" }),
        ...(prefer.length ? { Prefer: prefer.join(",") } : {}),
        ...this.headers
      },
      body: this.payload === undefined ? undefined : JSON.stringify(this.payload),
      ...(this.table.startsWith("rpc/") ? { signal: AbortSignal.timeout(10000) } : {})
    });

    if (response.status === 204) return { response, rows: [] };

    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    if (!response.ok) {
      const message = body?.message || body?.hint || text || `HTTP ${response.status}`;
      // The code matters at two call sites — 23505 is the unique index that
      // makes "approached twice" and "two open sessions" impossible — so it is
      // carried through rather than flattened into a sentence.
      throw new RestError(message, { code: body?.code ?? null, status: response.status, details: body?.details ?? null });
    }

    if (body === null) return { response, rows: [] };
    return { response, rows: Array.isArray(body) ? body : [body] };
  }

  async #send() {
    return (await this.#fetch()).rows;
  }

  /** Every matching row. */
  async rows() {
    return this.#send();
  }

  /** The first row, or null. */
  async maybeSingle() {
    if (!this.params.has("limit")) this.limit(1);
    const rows = await this.#send();
    return rows[0] ?? null;
  }

  /** Exactly one row, or a thrown error — used where a write must have landed. */
  async single() {
    const rows = await this.#send();
    if (rows.length !== 1) throw new RestError(`Expected one row from ${this.table}, got ${rows.length}`, { status: 500 });
    return rows[0];
  }

  /**
   * How many rows match, without carrying them back. PostgREST answers this in
   * a header rather than the body, which is the whole point: the forecast asks
   * how many people are in a folder of twenty-two thousand, and the answer must
   * not cost twenty-two thousand rows.
   */
  async count() {
    if (!this.params.has("select")) this.select("id");
    this.headers = { ...this.headers, Prefer: "count=exact", Range: "0-0" };
    const { response } = await this.#fetch();
    // `0-0/12038`, or `*/0` when nothing matched at all.
    const total = /\/(\d+)$/.exec(response.headers.get("content-range") || "")?.[1];
    return total === undefined ? 0 : Number(total);
  }
}

/**
 * A client is built around a config thunk rather than values, so a missing
 * variable fails the one request that needed it — with a sentence naming what
 * is missing — instead of taking the whole server down at import.
 */
export function createRestClient({ label, resolve }) {
  const client = {
    label,
    config() {
      const config = resolve();
      if (config.missing?.length) {
        throw new RestError(
          `${label} is not configured: ${config.missing.join(", ")} ${config.missing.length > 1 ? "are" : "is"} not set`,
          { status: 503 }
        );
      }
      return config;
    },
    configured() {
      return !resolve().missing?.length;
    },
    missing() {
      return resolve().missing || [];
    },
    from(table) {
      return new Query(client, table);
    },
    rpc(name, args = {}) {
      if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new TypeError("Invalid RPC name");
      return new Query(client, `rpc/${name}`).insert(args);
    }
  };
  return client;
}
