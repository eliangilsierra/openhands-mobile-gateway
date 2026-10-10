import type { Migration } from "../schema-migration.js";

/**
 * Creates every table from architecture §8 "Data": `chat_state`, `conversation_binding` (with
 * the partial unique index on the active binding per chat+project), `event_cursor`, `seen_event`,
 * `pending_confirmation` and `schema_migration` itself.
 *
 * This file is forward-only and additive, per ADR-0003 point 6: once merged, it must never be
 * edited again. A later schema change is a new numbered migration file (see `src/store/README.md`).
 */
const migration001Init: Migration = {
  version: 1,
  description: "init",
  sql: `
    CREATE TABLE schema_migration (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE chat_state (
      channel TEXT NOT NULL,
      external_chat_id TEXT NOT NULL,
      active_project TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (channel, external_chat_id)
    );

    CREATE TABLE conversation_binding (
      id INTEGER PRIMARY KEY,
      channel TEXT NOT NULL,
      external_chat_id TEXT NOT NULL,
      project_key TEXT NOT NULL,
      working_dir TEXT NOT NULL,
      conversation_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('active', 'stale', 'closed')),
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX idx_conversation_binding_active_key
      ON conversation_binding (channel, external_chat_id, project_key)
      WHERE state = 'active';

    CREATE INDEX idx_conversation_binding_chat_state
      ON conversation_binding (channel, external_chat_id, state);

    CREATE INDEX idx_conversation_binding_state_last_used
      ON conversation_binding (state, last_used_at);

    CREATE TABLE event_cursor (
      conversation_id TEXT PRIMARY KEY,
      last_event_id TEXT,
      last_event_timestamp TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE seen_event (
      conversation_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, event_id)
    );

    CREATE TABLE pending_confirmation (
      id INTEGER PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      action_event_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      external_chat_id TEXT NOT NULL,
      channel_message_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      decision TEXT
    );

    CREATE INDEX idx_pending_confirmation_resolved_at
      ON pending_confirmation (resolved_at);
  `,
};

export default migration001Init;
