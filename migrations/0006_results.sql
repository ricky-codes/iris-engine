-- Resultados por ação. Um resultado por pedido.
--
-- Cada tabela raiz repete o `action_id` fixo (CHECK) numa chave estrangeira composta,
-- por isso um resultado de sentimento só pode existir num pedido de sentimento.
-- Os textos gerados contêm dados pessoais: um trabalho de retenção apaga estas
-- tabelas segundo `tenant.result_retention_days`; os metadados do pedido ficam.

-- ---------- sentimento (ação 1) ----------

CREATE TABLE sentiment_result (
  inference_request_id uuid         PRIMARY KEY,
  action_id            smallint     NOT NULL DEFAULT 1 CHECK (action_id = 1),
  sentiment_label_id   smallint     NOT NULL REFERENCES sentiment_label,
  urgency_level_id     smallint     NOT NULL REFERENCES urgency_level,
  score                numeric(4,3) NOT NULL CHECK (score BETWEEN 0 AND 1),
  summary              text         NOT NULL CHECK (btrim(summary) <> ''),
  recommended_tone     text         NOT NULL CHECK (btrim(recommended_tone) <> ''),
  FOREIGN KEY (inference_request_id, action_id)
    REFERENCES inference_request (inference_request_id, action_id) ON DELETE CASCADE
);

CREATE TABLE sentiment_signal (
  inference_request_id uuid     NOT NULL REFERENCES sentiment_result ON DELETE CASCADE,
  position             smallint NOT NULL CHECK (position BETWEEN 1 AND 5),
  signal               text     NOT NULL CHECK (btrim(signal) <> ''),
  PRIMARY KEY (inference_request_id, position)
);

-- ---------- tipificação (ação 2) ----------

CREATE TABLE tipification_result (
  inference_request_id uuid         PRIMARY KEY,
  action_id            smallint     NOT NULL DEFAULT 2 CHECK (action_id = 2),
  score                numeric(4,3) NOT NULL CHECK (score BETWEEN 0 AND 1),
  summary              text         NOT NULL CHECK (btrim(summary) <> ''),
  FOREIGN KEY (inference_request_id, action_id)
    REFERENCES inference_request (inference_request_id, action_id) ON DELETE CASCADE
);

-- Uma linha por nível. Um cliente com 3 ou 6 níveis não altera o esquema.
-- `value` vazio com `is_included` falso = sem proposta para esse nível.
CREATE TABLE tipification_result_value (
  inference_request_id        uuid    NOT NULL REFERENCES tipification_result ON DELETE CASCADE,
  classification_dimension_id integer NOT NULL REFERENCES classification_dimension,
  value                       text    NOT NULL,
  is_included                 boolean NOT NULL,
  PRIMARY KEY (inference_request_id, classification_dimension_id),
  CHECK (NOT is_included OR value <> '')
);
CREATE INDEX tipification_result_value_dimension_idx
  ON tipification_result_value (classification_dimension_id);

-- O nível pertence ao mesmo cliente que o pedido.
CREATE FUNCTION tipification_value_check_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM inference_request r
    JOIN org_user u                 ON u.org_user_id = r.org_user_id
    JOIN sf_org o                   ON o.sf_org_id = u.sf_org_id
    JOIN classification_dimension d ON d.classification_dimension_id = NEW.classification_dimension_id
    WHERE r.inference_request_id = NEW.inference_request_id
      AND d.tenant_id = o.tenant_id
  ) THEN
    RAISE EXCEPTION 'tipification_result_value: o nível % não pertence ao cliente do pedido %',
      NEW.classification_dimension_id, NEW.inference_request_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER tipification_value_tenant
  BEFORE INSERT OR UPDATE OF inference_request_id, classification_dimension_id
  ON tipification_result_value
  FOR EACH ROW EXECUTE FUNCTION tipification_value_check_tenant();

-- ---------- resposta sugerida (ação 3) ----------

-- Parâmetros de entrada próprios da ação. `is_incoming` só faz sentido para emails
-- e `is_published` para comentários; o que não se aplica fica nulo.
CREATE TABLE reply_request (
  inference_request_id uuid     PRIMARY KEY,
  action_id            smallint NOT NULL DEFAULT 3 CHECK (action_id = 3),
  message_item_type_id smallint NOT NULL REFERENCES message_item_type,
  sf_item_id           text     NOT NULL CHECK (sf_item_id ~ '^[A-Za-z0-9]{18}$'),
  is_incoming          boolean,
  is_published         boolean,
  tom                  smallint NOT NULL CHECK (tom BETWEEN 0 AND 100),
  simpatia             smallint NOT NULL CHECK (simpatia BETWEEN 0 AND 100),
  formalidade          smallint NOT NULL CHECK (formalidade BETWEEN 0 AND 100),
  CHECK (message_item_type_id = 1 OR is_incoming IS NULL),
  CHECK (message_item_type_id = 2 OR is_published IS NULL),
  FOREIGN KEY (inference_request_id, action_id)
    REFERENCES inference_request (inference_request_id, action_id) ON DELETE CASCADE
);

-- Não pode existir resposta sem os parâmetros que a geraram.
CREATE TABLE reply_result (
  inference_request_id uuid PRIMARY KEY REFERENCES reply_request ON DELETE CASCADE,
  reply                text NOT NULL CHECK (btrim(reply) <> ''),
  subject              text NOT NULL DEFAULT '',
  recommended_tone     text NOT NULL CHECK (btrim(recommended_tone) <> '')
);
