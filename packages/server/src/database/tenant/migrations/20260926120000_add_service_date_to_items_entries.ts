/**
 * Adds the optional service date shown as the "Service date" column of the
 * invoice line items. Nullable: existing lines and other documents have none.
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function (knex) {
  return knex.schema.alterTable('items_entries', (table) => {
    table.date('service_date').nullable().after('description');
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function (knex) {
  return knex.schema.alterTable('items_entries', (table) => {
    table.dropColumn('service_date');
  });
};
