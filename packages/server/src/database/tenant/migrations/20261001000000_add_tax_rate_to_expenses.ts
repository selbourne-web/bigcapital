/**
 * Per-line tax rates on expenses, the same way bills carry them: each line
 * may have a tax rate (with the rate snapshotted at save time), and the
 * expense says whether its line amounts include or exclude that tax.
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function (knex) {
  return knex.schema
    .alterTable('expenses_transactions', (table) => {
      table.boolean('is_inclusive_tax').defaultTo(false);
    })
    .alterTable('expense_transaction_categories', (table) => {
      table
        .integer('tax_rate_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('tax_rates');
      table.decimal('tax_rate').unsigned().nullable();
    });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function (knex) {
  return knex.schema
    .alterTable('expense_transaction_categories', (table) => {
      table.dropForeign(['tax_rate_id']);
      table.dropColumn('tax_rate_id');
      table.dropColumn('tax_rate');
    })
    .alterTable('expenses_transactions', (table) => {
      table.dropColumn('is_inclusive_tax');
    });
};
