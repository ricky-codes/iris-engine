-- Definições do motor alteráveis sem reiniciar (modelos por omissão, tempos, disjuntor,
-- streaming, limite de pedidos, StepAccess e limites das memórias). Sem linha, vale o valor do
-- `.env` ou do código. Só a API de administração escreve aqui, e valida cada valor.

CREATE TABLE engine_setting (
  key        text        PRIMARY KEY CHECK (key ~ '^[a-z][A-Za-z]{1,63}$'),
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text        NOT NULL CHECK (btrim(updated_by) <> '' AND char_length(updated_by) <= 200)
);

-- Um inteiro de engine_setting, ou o valor por omissão.
CREATE FUNCTION engine_setting_int(setting text, fallback integer) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT (value #>> '{}')::integer FROM engine_setting WHERE key = setting),
    fallback)
$$;

-- Os limites das memórias passam a vir de engine_setting (500 caracteres, 50 por org e 20 por
-- utilizador sem nada gravado). O limite em vigor vai no DETAIL do erro, para a mensagem.
ALTER TABLE memory DROP CONSTRAINT memory_content_check;
ALTER TABLE memory ADD CONSTRAINT memory_content_check
  CHECK (btrim(content) <> '' AND char_length(content) <= 2000);

CREATE FUNCTION memory_check_length() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  max_chars integer := engine_setting_int('memoryMaxChars', 500);
BEGIN
  IF char_length(NEW.content) > max_chars THEN
    RAISE EXCEPTION 'memory_too_long: no máximo % caracteres', max_chars
      USING ERRCODE = 'check_violation', DETAIL = max_chars::text;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER memory_length
  BEFORE INSERT OR UPDATE OF content ON memory
  FOR EACH ROW EXECUTE FUNCTION memory_check_length();

CREATE OR REPLACE FUNCTION org_memory_check_limit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  max_count integer := engine_setting_int('memoryPerOrg', 50);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('org_memory:' || NEW.sf_org_ref, 0));
  IF (SELECT count(*) FROM org_memory
      WHERE sf_org_ref = NEW.sf_org_ref AND memory_id <> NEW.memory_id) >= max_count THEN
    RAISE EXCEPTION 'memory_limit: a org % já tem % memórias', NEW.sf_org_ref, max_count
      USING ERRCODE = 'check_violation', DETAIL = max_count::text;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION user_memory_check_limit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  max_count integer := engine_setting_int('memoryPerUser', 20);
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('user_memory:' || NEW.sf_org_ref || ':' || NEW.sf_user_ref, 0));
  IF (SELECT count(*) FROM user_memory
      WHERE sf_org_ref = NEW.sf_org_ref AND sf_user_ref = NEW.sf_user_ref
        AND memory_id <> NEW.memory_id) >= max_count THEN
    RAISE EXCEPTION 'memory_limit: o utilizador % já tem % memórias', NEW.sf_user_ref, max_count
      USING ERRCODE = 'check_violation', DETAIL = max_count::text;
  END IF;
  RETURN NEW;
END
$$;
