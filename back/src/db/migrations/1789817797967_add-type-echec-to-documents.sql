-- Up Migration

-- NULL = document traité normalement, sans échec.
-- 'technique' = erreur transitoire (retry déjà tenté, épuisé) ; 'metier' = doute réel
-- sur le contenu, jamais de retry. Les deux catégories ne se traitent jamais pareil
-- côté graphe (cf. back/src/graph/pipeline.ts), la colonne ne fait que refléter ça.
ALTER TABLE documents
  ADD COLUMN type_echec TEXT
  CHECK (type_echec IN ('technique', 'metier'));

-- Down Migration

ALTER TABLE documents
  DROP COLUMN IF EXISTS type_echec;
