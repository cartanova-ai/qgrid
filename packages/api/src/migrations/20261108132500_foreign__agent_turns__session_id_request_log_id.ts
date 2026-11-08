import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  return knex.schema.alterTable("agent_turns", (table) => {
    // create fk
    table
      .foreign("session_id")
      .references("agent_sessions.id")
      .onUpdate("CASCADE")
      .onDelete("CASCADE");
    table
      .foreign("request_log_id")
      .references("request_logs.id")
      .onUpdate("CASCADE")
      .onDelete("SET NULL");
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.alterTable("agent_turns", (table) => {
    // drop fk
    table.dropForeign(["session_id"]);
    table.dropForeign(["request_log_id"]);
  });
}
