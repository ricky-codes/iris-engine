-- Identidade: cliente -> org Salesforce -> utilizador.
-- O cliente nunca é repetido abaixo da org: deriva sempre dela.

CREATE TABLE tenant (
  tenant_id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                  text        NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name                  text        NOT NULL CHECK (btrim(name) <> ''),
  result_retention_days integer     NOT NULL DEFAULT 30 CHECK (result_retention_days > 0),
  is_active             boolean     NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Apagar um cliente ou uma org só é possível sem filhos (NO ACTION): é um ato explícito.
CREATE TABLE sf_org (
  sf_org_id    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenant,
  -- Id Salesforce de org, sempre com 18 caracteres.
  sf_org_ref   text        NOT NULL UNIQUE CHECK (sf_org_ref ~ '^00D[A-Za-z0-9]{15}$'),
  instance_url text        NOT NULL CHECK (instance_url ~ '^https://[^/\s]+$'),
  is_sandbox   boolean     NOT NULL,
  is_active    boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sf_org_tenant_idx ON sf_org (tenant_id);

-- O utilizador é só (org, id Salesforce). O mesmo humano em produção e em sandbox
-- são dois utilizadores. Não se guarda nome nem email.
CREATE TABLE org_user (
  org_user_id   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sf_org_id     uuid        NOT NULL REFERENCES sf_org,
  sf_user_ref   text        NOT NULL CHECK (sf_user_ref ~ '^005[A-Za-z0-9]{15}$'),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sf_org_id, sf_user_ref)
);

-- Só o hash SHA-256 da chave. Podem existir duas ativas por org para rodar sem paragem
-- (limite aplicado pela aplicação).
CREATE TABLE api_credential (
  api_credential_id uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sf_org_id         uuid        NOT NULL REFERENCES sf_org,
  key_prefix        text        NOT NULL UNIQUE CHECK (key_prefix ~ '^[A-Za-z0-9_-]{8,32}$'),
  secret_hash       bytea       NOT NULL CHECK (octet_length(secret_hash) = 32),
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz,
  revoked_at        timestamptz,
  CHECK (expires_at IS NULL OR expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX api_credential_org_idx ON api_credential (sf_org_id);
