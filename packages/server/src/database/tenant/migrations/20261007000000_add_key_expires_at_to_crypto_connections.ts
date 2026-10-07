/**
 * Expiry of the exchange API key, when the exchange reports one (Crypto.com App
 * keys expire after about 90 days). Surfaced in the UI so the owner can rotate
 * the key before it stops working. Additive and nullable.
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('crypto_connections', (table) => {
    table.dateTime('key_expires_at').nullable();
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.alterTable('crypto_connections', (table) => {
    table.dropColumn('key_expires_at');
  });
};
