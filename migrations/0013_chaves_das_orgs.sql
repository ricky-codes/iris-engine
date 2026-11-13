-- Chaves das orgs: cada org assina os seus pedidos (JWT HS256) com uma chave própria, e a IRIS
-- tira daí o orgId e o userId. O segredo fica cifrado (AES-256-GCM, com ORG_KEY_ENCRYPTION_KEY):
-- a base de dados sozinha não chega para assinar pedidos.

CREATE TABLE org_key (
  org_key_id text        PRIMARY KEY CHECK (org_key_id ~ '^k_[0-9a-f]{16}$'),
  sf_org_ref text        NOT NULL CHECK (sf_org_ref ~ '^00D[A-Za-z0-9]{15}$'),
  -- iv (12 bytes) | etiqueta (16 bytes) | segredo cifrado
  secret_enc bytea       NOT NULL CHECK (octet_length(secret_enc) > 28),
  created_by text        NOT NULL CHECK (btrim(created_by) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_by text,
  revoked_at timestamptz,
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX org_key_org_idx ON org_key (sf_org_ref);
