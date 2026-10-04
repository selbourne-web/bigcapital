/**
 * Crypto exchange connectors (piece 1): connections, append-only raw
 * records, balance snapshots and sync run history.
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.createTable('crypto_connections', (table) => {
    table.increments('id');
    table.string('exchange', 32).notNullable();
    table.string('label', 255).notNullable();
    table.text('api_key_encrypted').notNullable();
    table.text('api_secret_encrypted').notNullable();
    table.text('passphrase_encrypted').nullable();
    table.integer('key_version').unsigned().notNullable().defaultTo(1);
    table.string('key_hint', 8).nullable();
    table.string('status', 16).notNullable().defaultTo('active');
    table.dateTime('last_sync_at').nullable();
    table.text('last_error').nullable();
    table
      .integer('account_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('accounts')
      .onDelete('RESTRICT');
    table.unique('account_id');
    table.timestamps();
  });

  await knex.schema.createTable('crypto_raw_records', (table) => {
    table.increments('id');
    table
      .integer('connection_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('crypto_connections')
      .onDelete('CASCADE');
    table.string('record_type', 16).notNullable();
    table.string('exchange_record_id', 191).notNullable();
    table.dateTime('occurred_at').notNullable();
    table.json('payload').notNullable();
    table.specificType('payload_hash', 'char(64)').notNullable();
    table.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
    table.unique(
      ['connection_id', 'record_type', 'exchange_record_id'],
      'crypto_raw_records_unique_record',
    );
    table.index(['connection_id', 'occurred_at']);
  });

  await knex.schema.createTable('crypto_balance_snapshots', (table) => {
    table.increments('id');
    table
      .integer('connection_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('crypto_connections')
      .onDelete('CASCADE');
    table.string('asset', 32).notNullable();
    table.decimal('free', 36, 18).notNullable().defaultTo(0);
    table.decimal('locked', 36, 18).notNullable().defaultTo(0);
    table.dateTime('captured_at').notNullable();
    table.index(['connection_id', 'captured_at']);
  });

  await knex.schema.createTable('crypto_sync_runs', (table) => {
    table.increments('id');
    table
      .integer('connection_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('crypto_connections')
      .onDelete('CASCADE');
    table.string('kind', 16).notNullable();
    table.string('status', 16).notNullable();
    table.dateTime('range_from').nullable();
    table.dateTime('range_to').nullable();
    table.integer('fetched_count').unsigned().notNullable().defaultTo(0);
    table.integer('inserted_count').unsigned().notNullable().defaultTo(0);
    table.text('errors').nullable();
    table.dateTime('started_at').notNullable();
    table.dateTime('finished_at').nullable();
    table.index(['connection_id', 'started_at']);
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('crypto_sync_runs');
  await knex.schema.dropTableIfExists('crypto_balance_snapshots');
  await knex.schema.dropTableIfExists('crypto_raw_records');
  await knex.schema.dropTableIfExists('crypto_connections');
};
