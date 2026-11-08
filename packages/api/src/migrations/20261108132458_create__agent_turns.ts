import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("agent_turns", (table) => {
    table.increments().primary();
    table.string("session_id", 36).notNullable();
    table.integer("index").notNullable();
    table.text("prompt").notNullable();
    table.text("status").notNullable();
    table.integer("request_log_id").nullable();
    table.jsonb("pending_actions").notNullable();
    table.jsonb("logged_steps").notNullable();
    table.integer("last_logged_event_seq").notNullable().defaultTo(knex.raw("0"));
    table.integer("model_call_count").notNullable().defaultTo(knex.raw("0"));
    table
      .timestamp("started_at", { useTz: true, precision: 3 })
      .notNullable()
      .defaultTo(knex.raw("CURRENT_TIMESTAMP"));
    table.timestamp("finished_at", { useTz: true, precision: 3 }).nullable();
    table.text("result_text").nullable();
    table.text("error_message").nullable();
    table.jsonb("usage").nullable();
  });
  await knex.raw(
    `CREATE UNIQUE INDEX agent_turns_session_id_index_unique ON agent_turns USING btree(session_id, index);`,
  );
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTable("agent_turns");
}
