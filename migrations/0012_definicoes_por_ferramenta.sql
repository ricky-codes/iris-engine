-- Definições do motor que uma ferramenta pode substituir. NULL: vale a definição global
-- (engine_setting ou .env). Os limites são os mesmos de PATCH /v1/admin/settings.

ALTER TABLE tool_config
  ADD COLUMN max_attempts          smallint CHECK (max_attempts BETWEEN 1 AND 5),
  ADD COLUMN total_timeout_ms      integer  CHECK (total_timeout_ms BETWEEN 2000 AND 115000),
  ADD COLUMN rate_limit_per_minute integer  CHECK (rate_limit_per_minute BETWEEN 0 AND 100000),
  ADD COLUMN stream_enabled        boolean;
