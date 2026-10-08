-- Pedidos e chamadas ao modelo. Só metadados: nunca o corpo do pedido nem o prompt
-- montado (contêm dados pessoais de clientes finais). Ficam o hash e o tamanho.
--
-- Pedidos rejeitados por falta de credencial não aparecem aqui: ainda não há
-- utilizador identificado. Ficam só nos logs.
--
-- Apagar um utilizador apaga os pedidos dele (pedido de apagamento).

CREATE TABLE inference_request (
  inference_request_id uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_user_id          uuid        NOT NULL REFERENCES org_user ON DELETE CASCADE,
  action_id            smallint    NOT NULL REFERENCES action,
  request_status_id    smallint    NOT NULL REFERENCES request_status,
  error_type_id        smallint    REFERENCES error_type,
  sf_record_id         text        NOT NULL CHECK (sf_record_id ~ '^[A-Za-z0-9]{18}$'),
  client_ts            timestamptz,
  payload_sha256       bytea       NOT NULL CHECK (octet_length(payload_sha256) = 32),
  payload_bytes        integer     NOT NULL CHECK (payload_bytes >= 0),
  served_from_cache    boolean     NOT NULL DEFAULT false,
  received_at          timestamptz NOT NULL,
  completed_at         timestamptz,
  CHECK (completed_at IS NULL OR completed_at >= received_at),
  -- failed (4) e rejected (5) têm sempre erro; os restantes estados nunca.
  CHECK ((request_status_id IN (4, 5)) = (error_type_id IS NOT NULL)),
  -- Alvo das chaves estrangeiras compostas das tabelas de resultado.
  UNIQUE (inference_request_id, action_id)
);
CREATE INDEX inference_request_user_time_idx   ON inference_request (org_user_id, received_at DESC);
CREATE INDEX inference_request_action_time_idx ON inference_request (action_id, received_at DESC);
CREATE INDEX inference_request_record_idx      ON inference_request (sf_record_id, received_at DESC);

CREATE TABLE llm_call (
  llm_call_id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  inference_request_id uuid        NOT NULL REFERENCES inference_request ON DELETE CASCADE,
  attempt              smallint    NOT NULL CHECK (attempt > 0),
  prompt_version_id    integer     NOT NULL REFERENCES prompt_version,
  requested_model_id   integer     NOT NULL REFERENCES llm_model,
  served_model_id      integer     REFERENCES llm_model,
  input_tokens         integer     CHECK (input_tokens >= 0),
  cached_input_tokens  integer     CHECK (cached_input_tokens >= 0),
  output_tokens        integer     CHECK (output_tokens >= 0),
  finish_reason        text,
  started_at           timestamptz NOT NULL,
  completed_at         timestamptz,
  UNIQUE (inference_request_id, attempt),
  CHECK (completed_at IS NULL OR completed_at >= started_at),
  CHECK (cached_input_tokens IS NULL OR input_tokens IS NULL OR cached_input_tokens <= input_tokens)
);
CREATE INDEX llm_call_prompt_version_idx ON llm_call (prompt_version_id);

-- O prompt usado numa chamada tem de ser da ação do pedido.
CREATE FUNCTION llm_call_check_prompt_action() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM prompt_version pv
    JOIN prompt p            ON p.prompt_id = pv.prompt_id
    JOIN inference_request r ON r.inference_request_id = NEW.inference_request_id
    WHERE pv.prompt_version_id = NEW.prompt_version_id
      AND p.action_id = r.action_id
  ) THEN
    RAISE EXCEPTION 'llm_call: o prompt_version % não pertence à ação do pedido %',
      NEW.prompt_version_id, NEW.inference_request_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER llm_call_prompt_action
  BEFORE INSERT OR UPDATE OF inference_request_id, prompt_version_id ON llm_call
  FOR EACH ROW EXECUTE FUNCTION llm_call_check_prompt_action();
