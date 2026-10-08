-- Configuração por cliente: modelo e limites por ação, prompts versionados e
-- níveis da tipificação. Tudo dados, não código.

CREATE TABLE llm_model (
  llm_model_id   integer  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ai_provider_id smallint NOT NULL REFERENCES ai_provider,
  code           text     NOT NULL CHECK (btrim(code) <> ''),
  UNIQUE (ai_provider_id, code)
);

CREATE TABLE tenant_action_config (
  tenant_id         uuid         NOT NULL REFERENCES tenant ON DELETE CASCADE,
  action_id         smallint     NOT NULL REFERENCES action,
  llm_model_id      integer      NOT NULL REFERENCES llm_model,
  temperature       numeric(3,2) NOT NULL CHECK (temperature BETWEEN 0 AND 2),
  max_output_tokens integer      NOT NULL CHECK (max_output_tokens > 0),
  timeout_ms        integer      NOT NULL CHECK (timeout_ms > 0),
  is_enabled        boolean      NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, action_id)
);

-- tenant_id nulo = prompt por omissão da ação, usado por clientes sem prompt próprio.
CREATE TABLE prompt (
  prompt_id integer  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action_id smallint NOT NULL REFERENCES action,
  tenant_id uuid     REFERENCES tenant ON DELETE CASCADE,
  UNIQUE NULLS NOT DISTINCT (action_id, tenant_id)
);

CREATE TABLE prompt_version (
  prompt_version_id integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  prompt_id         integer     NOT NULL REFERENCES prompt ON DELETE CASCADE,
  version           integer     NOT NULL CHECK (version > 0),
  system_template   text        NOT NULL CHECK (btrim(system_template) <> ''),
  is_active         boolean     NOT NULL DEFAULT false,
  change_note       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (prompt_id, version)
);
-- No máximo uma versão ativa por prompt.
CREATE UNIQUE INDEX prompt_version_one_active_idx
  ON prompt_version (prompt_id) WHERE is_active;

-- Uma versão publicada nunca muda: o histórico de chamadas aponta para ela.
-- Só `is_active` e `change_note` podem ser alterados.
CREATE FUNCTION prompt_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.prompt_id IS DISTINCT FROM OLD.prompt_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.system_template IS DISTINCT FROM OLD.system_template THEN
    RAISE EXCEPTION 'prompt_version %: o conteúdo de uma versão é imutável', OLD.prompt_version_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER prompt_version_immutable
  BEFORE UPDATE ON prompt_version
  FOR EACH ROW EXECUTE FUNCTION prompt_version_immutable();

-- Níveis de tipificação de cada cliente. `output_key` é a chave no JSON do Salesforce.
-- A ordem tem de estar aqui: a ordem das chaves num objeto JSON não é garantida.
-- Os valores permitidos vêm sempre no pedido e não se guardam.
CREATE TABLE classification_dimension (
  classification_dimension_id integer  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id                   uuid     NOT NULL REFERENCES tenant ON DELETE CASCADE,
  output_key                  text     NOT NULL CHECK (output_key ~ '^[a-z][A-Za-z0-9]*$'),
  label                       text     NOT NULL CHECK (btrim(label) <> ''),
  position                    smallint NOT NULL CHECK (position > 0),
  UNIQUE (tenant_id, output_key),
  UNIQUE (tenant_id, position)
);
