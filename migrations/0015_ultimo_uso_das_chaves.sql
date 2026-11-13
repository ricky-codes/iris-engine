-- Último uso de cada chave: quando a IRIS aceitou um token assinado com ela pela última vez.
-- Gravado no máximo uma vez por minuto por chave e por instância. Serve para rodar chaves com
-- segurança: só se revoga a antiga quando a nova já está a ser usada.

ALTER TABLE org_key ADD COLUMN last_used_at timestamptz;
