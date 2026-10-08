-- Memórias: preferências e factos em texto livre. O texto vive só em `memory`;
-- o dono (cliente, org ou utilizador) vive numa tabela de ligação 1:1 por âmbito.
--
-- Garantias na própria base de dados:
--   * no máximo um dono: a ligação repete o âmbito e só aceita o seu (CHECK + FK composta);
--   * pelo menos um dono: trigger diferido verifica no commit;
--   * sem memórias órfãs: apagar o dono apaga a memória.

CREATE TABLE memory (
  memory_id       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_scope_id smallint    NOT NULL REFERENCES memory_scope,
  memory_kind_id  smallint    NOT NULL REFERENCES memory_kind,
  content         text        NOT NULL CHECK (btrim(content) <> '' AND char_length(content) <= 2000),
  created_by      uuid        REFERENCES org_user ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  CHECK (updated_at >= created_at),
  CHECK (archived_at IS NULL OR archived_at >= created_at),
  -- Alvo das chaves estrangeiras compostas das tabelas de dono.
  UNIQUE (memory_id, memory_scope_id)
);

CREATE TABLE tenant_memory (
  memory_id       uuid     PRIMARY KEY,
  memory_scope_id smallint NOT NULL DEFAULT 1 CHECK (memory_scope_id = 1),
  tenant_id       uuid     NOT NULL REFERENCES tenant ON DELETE CASCADE,
  FOREIGN KEY (memory_id, memory_scope_id)
    REFERENCES memory (memory_id, memory_scope_id) ON DELETE CASCADE
);
CREATE INDEX tenant_memory_owner_idx ON tenant_memory (tenant_id);

CREATE TABLE sf_org_memory (
  memory_id       uuid     PRIMARY KEY,
  memory_scope_id smallint NOT NULL DEFAULT 2 CHECK (memory_scope_id = 2),
  sf_org_id       uuid     NOT NULL REFERENCES sf_org ON DELETE CASCADE,
  FOREIGN KEY (memory_id, memory_scope_id)
    REFERENCES memory (memory_id, memory_scope_id) ON DELETE CASCADE
);
CREATE INDEX sf_org_memory_owner_idx ON sf_org_memory (sf_org_id);

CREATE TABLE org_user_memory (
  memory_id       uuid     PRIMARY KEY,
  memory_scope_id smallint NOT NULL DEFAULT 3 CHECK (memory_scope_id = 3),
  org_user_id     uuid     NOT NULL REFERENCES org_user ON DELETE CASCADE,
  FOREIGN KEY (memory_id, memory_scope_id)
    REFERENCES memory (memory_id, memory_scope_id) ON DELETE CASCADE
);
CREATE INDEX org_user_memory_owner_idx ON org_user_memory (org_user_id);

-- Restrição opcional por ação. Sem linhas, a memória vale para todas as ações.
CREATE TABLE memory_action (
  memory_id uuid     NOT NULL REFERENCES memory ON DELETE CASCADE,
  action_id smallint NOT NULL REFERENCES action,
  PRIMARY KEY (memory_id, action_id)
);

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
    WHEN 1 THEN EXISTS (SELECT 1 FROM tenant_memory   WHERE memory_id = NEW.memory_id)
    WHEN 2 THEN EXISTS (SELECT 1 FROM sf_org_memory   WHERE memory_id = NEW.memory_id)
    WHEN 3 THEN EXISTS (SELECT 1 FROM org_user_memory WHERE memory_id = NEW.memory_id)
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

-- Apagar o dono (cliente, org ou utilizador) apaga a memória. É assim que um
-- pedido de apagamento de um utilizador remove também as memórias dele.
CREATE FUNCTION memory_delete_with_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM memory WHERE memory_id = OLD.memory_id;
  RETURN NULL;
END
$$;

CREATE TRIGGER tenant_memory_cleanup
  AFTER DELETE ON tenant_memory
  FOR EACH ROW EXECUTE FUNCTION memory_delete_with_owner();
CREATE TRIGGER sf_org_memory_cleanup
  AFTER DELETE ON sf_org_memory
  FOR EACH ROW EXECUTE FUNCTION memory_delete_with_owner();
CREATE TRIGGER org_user_memory_cleanup
  AFTER DELETE ON org_user_memory
  FOR EACH ROW EXECUTE FUNCTION memory_delete_with_owner();
