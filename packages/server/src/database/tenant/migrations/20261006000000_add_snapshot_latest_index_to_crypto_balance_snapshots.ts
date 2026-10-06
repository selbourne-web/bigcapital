/**
 * Index for the "latest snapshot per (connection, asset)" lookups
 * (`max(id) ... GROUP BY connection_id, asset`) used by the balances query and
 * the sync service. The only prior index was (connection_id, captured_at), so
 * those queries scanned a connection's whole append-only history.
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('crypto_balance_snapshots', (table) => {
    table.index(
      ['connection_id', 'asset', 'id'],
      'crypto_balance_snapshots_latest_idx',
    );
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.alterTable('crypto_balance_snapshots', (table) => {
    table.dropIndex(
      ['connection_id', 'asset', 'id'],
      'crypto_balance_snapshots_latest_idx',
    );
  });
};
