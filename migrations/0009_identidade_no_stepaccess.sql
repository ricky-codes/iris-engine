-- Orgs e utilizadores passam a viver só no StepAccess. A IRIS não guarda clientes, orgs,
-- utilizadores nem chaves: vê os ids Salesforce como texto que chega em cada pedido.
--
-- As memórias passam a ter como dono um id de org ou um par (id de org, id de utilizador).
-- As memórias que existiam são apagadas: até aqui não havia forma de as criar fora de testes.

-- ---------- memórias antigas: saem ----------

DROP TABLE memory_tool, tenant_memory, sf_org_memory, org_user_memory, memory;
DROP FUNCTION memory_check_owner();
DROP FUNCTION memory_delete_with_owner();
DROP TABLE memory_kind;

-- ---------- configuração por cliente: passa a ser por ferramenta ----------

DROP TABLE classification_dimension;

DROP TABLE tenant_tool_config;
CREATE TABLE tool_config (
  tool_id           smallint     PRIMARY KEY REFERENCES tool ON DELETE CASCADE,
  llm_model_id      integer      NOT NULL REFERENCES llm_model,
  temperature       numeric(3,2) NOT NULL CHECK (temperature BETWEEN 0 AND 2),
  max_output_tokens integer      NOT NULL CHECK (max_output_tokens > 0),
  timeout_ms        integer      NOT NULL CHECK (timeout_ms > 0),
  is_enabled        boolean      NOT NULL DEFAULT true
);

-- Um prompt por ferramenta. Os prompts próprios de clientes saem com as versões.
DELETE FROM prompt WHERE tenant_id IS NOT NULL;
ALTER TABLE prompt DROP COLUMN tenant_id;
ALTER TABLE prompt ADD CONSTRAINT prompt_tool_id_key UNIQUE (tool_id);

-- ---------- identidade: sai ----------

DROP TABLE api_credential, org_user, sf_org, tenant;

-- ---------- memórias ----------

-- Âmbitos que ficam: org (2) e utilizador (3). Os ids não mudam.
DELETE FROM memory_scope WHERE code = 'tenant';

-- Quem criou a memória: o próprio utilizador, a pedir à IRIS, ou um admin da Step.
CREATE TABLE memory_source (
  memory_source_id smallint PRIMARY KEY,
  code             text     NOT NULL UNIQUE CHECK (code ~ '^[a-z_]+$')
);
INSERT INTO memory_source (memory_source_id, code) VALUES
  (1, 'user'),
  (2, 'admin');

CREATE TABLE memory (
  memory_id        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_scope_id  smallint    NOT NULL REFERENCES memory_scope,
  memory_source_id smallint    NOT NULL REFERENCES memory_source,
  content          text        NOT NULL CHECK (btrim(content) <> '' AND char_length(content) <= 500),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (updated_at >= created_at),
  -- As memórias da org são regras da empresa: só um admin da Step as cria.
  CHECK (memory_scope_id <> 2 OR memory_source_id = 2),
  -- Alvo das chaves estrangeiras compostas das tabelas de dono.
  UNIQUE (memory_id, memory_scope_id)
);

CREATE TABLE org_memory (
  memory_id       uuid     PRIMARY KEY,
  memory_scope_id smallint NOT NULL DEFAULT 2 CHECK (memory_scope_id = 2),
  sf_org_ref      text     NOT NULL CHECK (sf_org_ref ~ '^00D[A-Za-z0-9]{15}$'),
  FOREIGN KEY (memory_id, memory_scope_id)
    REFERENCES memory (memory_id, memory_scope_id) ON DELETE CASCADE
);
CREATE INDEX org_memory_owner_idx ON org_memory (sf_org_ref);

CREATE TABLE user_memory (
  memory_id       uuid     PRIMARY KEY,
  memory_scope_id smallint NOT NULL DEFAULT 3 CHECK (memory_scope_id = 3),
  sf_org_ref      text     NOT NULL CHECK (sf_org_ref ~ '^00D[A-Za-z0-9]{15}$'),
  sf_user_ref     text     NOT NULL CHECK (sf_user_ref ~ '^005[A-Za-z0-9]{15}$'),
  FOREIGN KEY (memory_id, memory_scope_id)
    REFERENCES memory (memory_id, memory_scope_id) ON DELETE CASCADE
);
CREATE INDEX user_memory_owner_idx ON user_memory (sf_org_ref, sf_user_ref);

-- Restrição opcional por ferramenta. Sem linhas, a memória vale para todas.
CREATE TABLE memory_tool (
  memory_id uuid     NOT NULL REFERENCES memory ON DELETE CASCADE,
  tool_id   smallint NOT NULL REFERENCES tool ON DELETE CASCADE,
  PRIMARY KEY (memory_id, tool_id)
);
CREATE INDEX memory_tool_tool_idx ON memory_tool (tool_id);

-- Pelo menos um dono, verificado no fim da transação (a memória e a ligação
-- inserem-se na mesma transação, por esta ordem).
CREATE FUNCTION memory_check_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  has_owner boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM memory WHERE memory_id = NEW.memory_id) THEN
    RETURN NULL; -- apagada na mesma transação
  END IF;

  has_owner := CASE NEW.memory_scope_id
    WHEN 2 THEN EXISTS (SELECT 1 FROM org_memory  WHERE memory_id = NEW.memory_id)
    WHEN 3 THEN EXISTS (SELECT 1 FROM user_memory WHERE memory_id = NEW.memory_id)
    ELSE false
  END;

  IF NOT has_owner THEN
    RAISE EXCEPTION 'memory %: sem dono para o âmbito %', NEW.memory_id, NEW.memory_scope_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER memory_owner_required
  AFTER INSERT ON memory
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION memory_check_owner();

-- Apagar a ligação ao dono apaga a memória: não ficam memórias órfãs.
CREATE FUNCTION memory_delete_with_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM memory WHERE memory_id = OLD.memory_id;
  RETURN NULL;
END
$$;

CREATE TRIGGER org_memory_cleanup
  AFTER DELETE ON org_memory
  FOR EACH ROW EXECUTE FUNCTION memory_delete_with_owner();
CREATE TRIGGER user_memory_cleanup
  AFTER DELETE ON user_memory
  FOR EACH ROW EXECUTE FUNCTION memory_delete_with_owner();

-- Limites: 50 memórias por org e 20 por utilizador. O bloqueio por dono impede que
-- duas inserções em simultâneo passem ambas o limite.
CREATE FUNCTION org_memory_check_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('org_memory:' || NEW.sf_org_ref, 0));
  IF (SELECT count(*) FROM org_memory
      WHERE sf_org_ref = NEW.sf_org_ref AND memory_id <> NEW.memory_id) >= 50 THEN
    RAISE EXCEPTION 'memory_limit: a org % já tem 50 memórias', NEW.sf_org_ref
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER org_memory_limit
  BEFORE INSERT OR UPDATE OF sf_org_ref ON org_memory
  FOR EACH ROW EXECUTE FUNCTION org_memory_check_limit();

CREATE FUNCTION user_memory_check_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('user_memory:' || NEW.sf_org_ref || ':' || NEW.sf_user_ref, 0));
  IF (SELECT count(*) FROM user_memory
      WHERE sf_org_ref = NEW.sf_org_ref AND sf_user_ref = NEW.sf_user_ref
        AND memory_id <> NEW.memory_id) >= 20 THEN
    RAISE EXCEPTION 'memory_limit: o utilizador % já tem 20 memórias', NEW.sf_user_ref
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER user_memory_limit
  BEFORE INSERT OR UPDATE OF sf_org_ref, sf_user_ref ON user_memory
  FOR EACH ROW EXECUTE FUNCTION user_memory_check_limit();
