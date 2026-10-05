/**
 * Resume state for crypto syncs: the history cursor of an interrupted slice, the
 * timestamp the incremental window starts from, and when the initial backfill
 * finished.
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('crypto_connections', (table) => {
    table.text('sync_cursor').nullable();
    table.dateTime('last_seen_at').nullable();
    table.dateTime('initial_sync_completed_at').nullable();
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.alterTable('crypto_connections', (table) => {
    table.dropColumn('sync_cursor');
    table.dropColumn('last_seen_at');
    table.dropColumn('initial_sync_completed_at');
  });
};
