import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  return knex.schema.alterTable("agent_sessions", (table) => {
    // create fk
    table.foreign("token_id").references("tokens.id").onUpdate("CASCADE").onDelete("RESTRICT");
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.alterTable("agent_sessions", (table) => {
    // drop fk
    table.dropForeign(["token_id"]);
  });
}
