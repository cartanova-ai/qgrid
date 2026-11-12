import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("agent_sessions", (table) => {
    table.string("id", 36).primary().notNullable();
    table.text("status").notNullable();
    table.string("harness", 20).notNullable();
    table.string("model", 255).notNullable();
    table.integer("token_id").notNullable();
    table.text("token_name").notNullable();
    table.text("project_name").nullable();
    table.text("instructions").notNullable();
    table.jsonb("tools").notNullable();
    table.text("webhook_url").nullable();
    table.text("webhook_secret").nullable();
    table.jsonb("lifecycle_state").nullable();
    table.string("container_name", 100).notNullable();
    table.string("container_ip", 45).notNullable();
    table.integer("idle_ttl_sec").notNullable();
    table.integer("retain_sec").notNullable();
    table.string("stop_reason", 50).nullable();
    table
      .timestamp("last_turn_at", { useTz: true, precision: 3 })
      .notNullable()
      .defaultTo(knex.raw("CURRENT_TIMESTAMP"));
    table
      .timestamp("created_at", { useTz: true, precision: 3 })
      .notNullable()
      .defaultTo(knex.raw("CURRENT_TIMESTAMP"));
    table
      .timestamp("updated_at", { useTz: true, precision: 3 })
      .notNullable()
      .defaultTo(knex.raw("CURRENT_TIMESTAMP"));
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTable("agent_sessions");
}
