/**
 * Crypto connectors piece 2c: CSV imports. Adds the import-history table and
 * tags raw records with their origin (`source`, `import_id`) so one import can
 * be rolled back without touching API rows. `crypto_connections.mode` is added
 * with default `api` (csv_only connections arrive with piece 2d).
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.createTable('crypto_csv_imports', (table) => {
    table.increments('id');
    table
      .integer('connection_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('crypto_connections')
      .onDelete('CASCADE');
    table.string('exchange', 32).notNullable();
    table.string('report_type', 64).notNullable();
    table.string('original_filename', 255).notNullable();
    table.specificType('file_sha256', 'char(64)').notNullable();
    table.integer('row_count').unsigned().notNullable().defaultTo(0);
    table.integer('rows_imported').unsigned().notNullable().defaultTo(0);
    table
      .integer('rows_skipped_duplicate')
      .unsigned()
      .notNullable()
      .defaultTo(0);
    table.integer('rows_rejected').unsigned().notNullable().defaultTo(0);
    table.dateTime('date_from').nullable();
    table.dateTime('date_to').nullable();
    // previewed | committed | rolled_back | failed
    table.string('status', 16).notNullable().defaultTo('previewed');
    table.text('error').nullable();
    table.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
    table.dateTime('committed_at').nullable();
    table.integer('uploaded_by').unsigned().nullable();
    // Duplicate-file detection (committed only) lives in service logic, so a
    // rolled-back file can be imported again: no DB unique here.
    table.index(['connection_id', 'file_sha256']);
  });

  await knex.schema.alterTable('crypto_connections', (table) => {
    table.string('mode', 16).notNullable().defaultTo('api');
  });

  await knex.schema.alterTable('crypto_raw_records', (table) => {
    table.string('source', 8).notNullable().defaultTo('api');
    table
      .integer('import_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('crypto_csv_imports')
      .onDelete('SET NULL');
    table.index(['import_id']);
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  if (
    (await knex.schema.hasTable('crypto_raw_records')) &&
    (await knex.schema.hasColumn('crypto_raw_records', 'import_id'))
  ) {
    await knex.schema.alterTable('crypto_raw_records', (table) => {
      table.dropForeign(['import_id']);
      table.dropIndex(['import_id']);
      table.dropColumn('import_id');
    });
  }
  if (
    (await knex.schema.hasTable('crypto_raw_records')) &&
    (await knex.schema.hasColumn('crypto_raw_records', 'source'))
  ) {
    await knex.schema.alterTable('crypto_raw_records', (table) => {
      table.dropColumn('source');
    });
  }
  if (
    (await knex.schema.hasTable('crypto_connections')) &&
    (await knex.schema.hasColumn('crypto_connections', 'mode'))
  ) {
    await knex.schema.alterTable('crypto_connections', (table) => {
      table.dropColumn('mode');
    });
  }
  await knex.schema.dropTableIfExists('crypto_csv_imports');
};
