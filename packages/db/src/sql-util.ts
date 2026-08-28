import { sql, type SQL } from 'drizzle-orm'

/**
 * Bind a JS array as a Postgres array.
 *
 * drizzle's `sql` template hands a JS array to postgres.js as a scalar, so
 * `${['a','b']}::text[]` arrives as the literal `a` and Postgres answers
 * "malformed array literal". Round-tripping through jsonb is the reliable way to get a
 * real array out of a single bound parameter, whatever the driver does with it.
 */
export function pgArray(values: readonly (string | number)[], type: 'text' | 'uuid' | 'bigint'): SQL {
  // `array(select ...)` and not `(select array_agg(...))`. Postgres decides between the
  // array form and the subquery form of ANY/ALL syntactically: a bare parenthesised
  // SELECT is a subquery, so `= any((select array_agg(x) ...))` compares text against
  // text[] and fails. The ARRAY constructor is an expression, so it takes the array form.
  return sql`array(
    select x::${sql.raw(type)}
      from jsonb_array_elements_text(${JSON.stringify(values.map(String))}::jsonb) as t(x)
  )`
}

/**
 * Bind a Date as a timestamptz.
 *
 * drizzle hands a JS Date straight to postgres.js, which tries to treat it as a string
 * and throws. An ISO string with an explicit cast is unambiguous in both directions.
 */
export function pgTimestamp(value: Date): SQL {
  return sql`${value.toISOString()}::timestamptz`
}
