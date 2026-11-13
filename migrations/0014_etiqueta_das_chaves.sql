-- Etiqueta opcional de cada chave ("Produção", "Sandbox UAT"…): cada sandbox é uma org à parte,
-- e a etiqueta ajuda a saber de que ambiente é cada chave.

ALTER TABLE org_key
  ADD COLUMN label text CHECK (label IS NULL OR (label = btrim(label) AND char_length(label) BETWEEN 1 AND 100));
