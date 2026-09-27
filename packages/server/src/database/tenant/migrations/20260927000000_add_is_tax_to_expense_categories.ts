/**
 * Marks an expense line as the sales tax (VAT) charged on the other lines, so the
 * expenses list can show the total before tax and the tax separately.
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function (knex) {
  return knex.schema.alterTable('expense_transaction_categories', (table) => {
    table.boolean('is_tax').defaultTo(false).after('landed_cost');
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function (knex) {
  return knex.schema.alterTable('expense_transaction_categories', (table) => {
    table.dropColumn('is_tax');
  });
};
