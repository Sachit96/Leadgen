import { getTableName, sql, type AnyColumn, type SQL } from 'drizzle-orm';

/**
 * A fully-qualified reference to an outer query's column, for use inside a raw
 * correlated subquery.
 *
 * Drizzle renders a column in the SELECT-field position *without* its table
 * qualifier — `${campaigns.id}` becomes `"id"`, not `"campaigns"."id"`. Inside
 * `(select count(*) from messages m where m.campaign_id = "id")` that bare name
 * resolves against `messages`, so the subquery correlates a table with itself
 * and silently returns the wrong answer instead of failing. In a WHERE clause
 * drizzle does qualify, which is why the bug only shows up in computed columns.
 *
 * This always emits `"table"."column"`, so the correlation means what it reads
 * like. Use it for every outer column referenced inside a raw subquery.
 */
export function outer(column: AnyColumn): SQL {
  return sql.raw(`"${getTableName(column.table)}"."${column.name}"`);
}
