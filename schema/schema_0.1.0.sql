-- Qgrid schema (tokens + request_logs)

CREATE TABLE IF NOT EXISTS tokens (
    id serial PRIMARY KEY,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    token text NOT NULL,
    name text,
    refresh_token text,
    expires_at bigint,
    account_uuid text,
    active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS request_logs (
    id serial PRIMARY KEY,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    token_name varchar(100) NOT NULL,
    query text NOT NULL,
    response text NOT NULL,
    input_tokens integer NOT NULL,
    output_tokens integer NOT NULL,
    cache_read_tokens integer NOT NULL,
    cache_creation_tokens integer NOT NULL,
    duration_ms integer NOT NULL
);
