-- Up Migration

-- Pas de CHECK "pas les deux en même temps" pour l'instant : l'exploration des 6 CSV
-- suggère que est_regroupement et est_acompte sont mutuellement exclusifs, mais ce
-- n'est pas garanti à 100% sur des données pas encore vues. À ajouter plus tard si
-- confirmé au chargement.
ALTER TABLE releve_ligne
  ADD COLUMN est_regroupement BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN est_acompte BOOLEAN NOT NULL DEFAULT false;

-- Nom extrait littéralement du libellé (préfixe VIR/AVOIR et suffixe REGROUPEMENT/
-- ACOMPTE retirés), AVANT toute tentative de matching contre fournisseur.nom. Trace
-- de ce qui a été extrait indépendamment du succès du matching en aval.
ALTER TABLE releve_ligne
  ADD COLUMN fournisseur_nom_brut TEXT;

-- Down Migration

ALTER TABLE releve_ligne
  DROP COLUMN IF EXISTS fournisseur_nom_brut,
  DROP COLUMN IF EXISTS est_acompte,
  DROP COLUMN IF EXISTS est_regroupement;
