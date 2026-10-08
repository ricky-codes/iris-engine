-- Catálogos: listas pequenas e fechadas. A aplicação trabalha com o `code`;
-- os ids são atribuídos à mão e nunca mudam.

CREATE TABLE action (
  action_id      smallint PRIMARY KEY,
  code           text     NOT NULL UNIQUE CHECK (code ~ '^[a-z_]+$'),
  is_implemented boolean  NOT NULL
);

CREATE TABLE ai_provider (
  ai_provider_id smallint PRIMARY KEY,
  code           text     NOT NULL UNIQUE CHECK (code ~ '^[a-z_]+$')
);

CREATE TABLE memory_scope (
  memory_scope_id smallint PRIMARY KEY,
  code            text     NOT NULL UNIQUE CHECK (code ~ '^[a-z_]+$')
);

CREATE TABLE memory_kind (
  memory_kind_id smallint PRIMARY KEY,
  code           text     NOT NULL UNIQUE CHECK (code ~ '^[a-z_]+$')
);

CREATE TABLE request_status (
  request_status_id smallint PRIMARY KEY,
  code              text     NOT NULL UNIQUE CHECK (code ~ '^[a-z_]+$')
);

CREATE TABLE error_type (
  error_type_id smallint PRIMARY KEY,
  code          text     NOT NULL UNIQUE CHECK (code ~ '^[a-z_]+$')
);

CREATE TABLE sentiment_label (
  sentiment_label_id smallint PRIMARY KEY,
  code               text     NOT NULL UNIQUE,
  sort_order         smallint NOT NULL UNIQUE
);

CREATE TABLE urgency_level (
  urgency_level_id smallint PRIMARY KEY,
  code             text     NOT NULL UNIQUE,
  sort_order       smallint NOT NULL UNIQUE
);

CREATE TABLE message_item_type (
  message_item_type_id smallint PRIMARY KEY,
  code                 text     NOT NULL UNIQUE
);

INSERT INTO action (action_id, code, is_implemented) VALUES
  (1, 'sentiment',    true),
  (2, 'tipification', true),
  (3, 'reply',        true),
  (4, 'knowledge',    false);

INSERT INTO ai_provider (ai_provider_id, code) VALUES
  (1, 'vertex_ai'),
  (2, 'openrouter');

-- Âmbitos de uma memória: quem é o dono.
INSERT INTO memory_scope (memory_scope_id, code) VALUES
  (1, 'tenant'),
  (2, 'org'),
  (3, 'user');

INSERT INTO memory_kind (memory_kind_id, code) VALUES
  (1, 'preference'),
  (2, 'fact');

INSERT INTO request_status (request_status_id, code) VALUES
  (1, 'received'),
  (2, 'running'),
  (3, 'succeeded'),
  (4, 'failed'),
  (5, 'rejected');

-- Os mesmos códigos que a API devolve (src/http/errors.ts).
INSERT INTO error_type (error_type_id, code) VALUES
  (1,  'invalid_request'),
  (2,  'unauthorized'),
  (3,  'forbidden'),
  (4,  'not_found'),
  (5,  'unknown_action'),
  (6,  'payload_too_large'),
  (7,  'unsupported_media_type'),
  (8,  'rate_limited'),
  (9,  'not_implemented'),
  (10, 'invalid_model_output'),
  (11, 'provider_unavailable'),
  (12, 'timeout'),
  (13, 'internal_error');

-- Valores literais que o Salesforce compara: acentos e maiúsculas contam.
INSERT INTO sentiment_label (sentiment_label_id, code, sort_order) VALUES
  (1, 'Positivo',       1),
  (2, 'Neutro',         2),
  (3, 'Negativo',       3),
  (4, 'Muito Negativo', 4),
  (5, 'Misto',          5);

INSERT INTO urgency_level (urgency_level_id, code, sort_order) VALUES
  (1, 'Baixa', 1),
  (2, 'Média', 2),
  (3, 'Alta',  3);

INSERT INTO message_item_type (message_item_type_id, code) VALUES
  (1, 'emailMessage'),
  (2, 'caseComment');
