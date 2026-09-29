exports.up = function (knex) {
  return knex.schema.table('uncategorized_cashflow_transactions', (table) => {
    // The account balance the bank reported after this transaction, as given
    // by a bank statement export (e.g. a "Running Balance" column). Optional
    // and only used to help verify an import matches the bank's own record -
    // nothing in the app computes from it.
    table.decimal('running_balance').nullable();
  });
};

exports.down = function (knex) {
  return knex.schema.table('uncategorized_cashflow_transactions', (table) => {
    table.dropColumn('running_balance');
  });
};
