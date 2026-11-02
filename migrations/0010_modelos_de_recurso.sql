-- Modelos de recurso por ferramenta: quando o modelo principal (ou o OpenRouter) falha, o motor
-- experimenta estes por ordem. No máximo 3, sem repetidos e nunca o próprio modelo principal.
--
-- Tabela filha com posição, em vez de um array em tool_config: cada modelo continua a ter chave
-- estrangeira para o catálogo llm_model, e a ordem e os repetidos ficam garantidos pela própria
-- base de dados.

CREATE TABLE tool_config_fallback (
  tool_id      smallint NOT NULL REFERENCES tool_config ON DELETE CASCADE,
  position     smallint NOT NULL CHECK (position BETWEEN 1 AND 3),
  llm_model_id integer  NOT NULL REFERENCES llm_model,
  PRIMARY KEY (tool_id, position),
  UNIQUE (tool_id, llm_model_id)
);

-- O modelo principal não pode ser também de recurso.
CREATE FUNCTION tool_config_fallback_check_main() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM tool_config
             WHERE tool_id = NEW.tool_id AND llm_model_id = NEW.llm_model_id) THEN
    RAISE EXCEPTION 'fallback_is_main: o modelo principal não pode ser de recurso'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER tool_config_fallback_main
  BEFORE INSERT OR UPDATE ON tool_config_fallback
  FOR EACH ROW EXECUTE FUNCTION tool_config_fallback_check_main();
