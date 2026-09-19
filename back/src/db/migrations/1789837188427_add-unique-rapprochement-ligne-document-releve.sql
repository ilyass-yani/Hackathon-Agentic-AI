-- Up Migration

-- Clé naturelle pour l'upsert du nœud reconciler (pipeline.ts) : un document ne peut
-- être rapproché qu'une seule fois avec une même ligne bancaire donnée. Sert aussi de
-- garde-fou en cas de re-traitement du même document.
ALTER TABLE rapprochement_ligne
  ADD CONSTRAINT rapprochement_ligne_document_id_releve_ligne_id_key
  UNIQUE (document_id, releve_ligne_id);

-- Down Migration

ALTER TABLE rapprochement_ligne
  DROP CONSTRAINT IF EXISTS rapprochement_ligne_document_id_releve_ligne_id_key;
