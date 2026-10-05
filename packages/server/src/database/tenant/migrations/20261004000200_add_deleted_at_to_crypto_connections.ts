/**
 * Soft-delete marker for crypto connections. The child tables (raw records,
 * balance snapshots, sync runs) reference crypto_connections with ON DELETE
 * CASCADE, so keeping the data after "remove connection" requires keeping the
 * row. Removing a connection without deleting data wipes its credentials and
 * account mapping and sets deleted_at.
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('crypto_connections', (table) => {
    table.dateTime('deleted_at').nullable();
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.alterTable('crypto_connections', (table) => {
    table.dropColumn('deleted_at');
  });
};
