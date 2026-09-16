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
 * PostgREST treats , . ( ) and spaces as syntax inside a filter value, so
 * anything carrying them is passed double-quoted. UUIDs and plain words go
 * through untouched, which keeps the common URL readable.
 */
function quoteValue(value) {
  if (value === null || value === undefined) return "null";
  const text = String(value);
  if (/^[A-Za-z0-9_\-:+ ]*$/.test(text) && !text.includes(" ")) return text;
  return `"${text.replace(/["\\]/g, "\\$&")}"`;
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
    this.params.append(column, `eq.${quoteValue(value)}`);
    return this;
  }

  neq(column, value) {
    this.params.append(column, `neq.${quoteValue(value)}`);
    return this;
  }

  in(column, values) {
    this.params.append(column, `in.(${(values || []).map(quoteValue).join(",")})`);
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
    this.params.append(column, `gte.${quoteValue(value)}`);
    return this;
  }

  /** Raw PostgREST `or=(a.ilike.*x*,b.ilike.*x*)` — the caller builds the clause. */
  or(clause) {
    this.params.append("or", `(${clause})`);
    return this;
  }

  order(column, { ascending = true, nullsFirst = null, foreignTable = null } = {}) {
    const direction = ascending ? "asc" : "desc";
    const nulls = nullsFirst === null ? "" : nullsFirst ? ".nullsfirst" : ".nullslast";
    this.params.append(foreignTable ? `${foreignTable}.order` : "order", `${column}.${direction}${nulls}`);
    return this;
  }

  limit(count, { foreignTable = null } = {}) {
    this.params.set(foreignTable ? `${foreignTable}.limit` : "limit", String(count));
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

  async #send() {
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
      body: this.payload === undefined ? undefined : JSON.stringify(this.payload)
    });

    if (response.status === 204) return [];

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

    if (body === null) return [];
    return Array.isArray(body) ? body : [body];
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
    }
  };
  return client;
}
