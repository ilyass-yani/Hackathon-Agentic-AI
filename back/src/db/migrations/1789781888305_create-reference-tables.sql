-- Up Migration

-- set_updated_at() a déjà été créée par la migration initiale (create-initial-schema) :
-- on réutilise la même fonction, pas besoin de la redéfinir.

-- ─────────────────────────────────────────────────────────────────────────────
-- compte_comptable
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE compte_comptable (
  -- Clé naturelle : le numéro de compte (ex: "6122") est l'identifiant métier stable
  -- utilisé partout ailleurs (fournisseur.compte_comptable), pas besoin d'id séparé.
  numero      TEXT PRIMARY KEY,
  libelle     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_compte_comptable_set_updated_at
BEFORE UPDATE ON compte_comptable
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- fournisseur
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE fournisseur (
  id                  BIGSERIAL PRIMARY KEY,
  nom                 TEXT NOT NULL,
  -- Clé de comparaison utilisée pour détecter les "tiers inconnus" lors du
  -- croisement des extractions : doit être unique.
  ice                 TEXT NOT NULL UNIQUE,
  -- Catégorie fiscale du référentiel (détermine le taux de TVA habituel), pas le
  -- type de produit facturé ; texte libre, pas de CHECK (catégories non figées).
  categorie           TEXT NOT NULL,
  taux_tva_habituel   NUMERIC(5, 2) NOT NULL,
  -- ON DELETE RESTRICT : même philosophie d'audit que rapprochement_ligne
  -- (cf. migration initiale) — on ne supprime pas silencieusement un compte
  -- comptable encore référencé par un fournisseur.
  compte_comptable    TEXT NOT NULL REFERENCES compte_comptable (numero) ON DELETE RESTRICT,
  -- oui/non dans le CSV source, mais c'est un fait binaire : BOOLEAN natif plutôt
  -- que du texte libre (conversion 'oui'->true / 'non'->false faite au seed).
  recurrent           BOOLEAN NOT NULL,
  -- Sert à détecter les montants aberrants (seuil : >10x cette valeur).
  montant_moyen_ttc   NUMERIC(14, 2) NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_fournisseur_compte_comptable ON fournisseur (compte_comptable);

CREATE TRIGGER trg_fournisseur_set_updated_at
BEFORE UPDATE ON fournisseur
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS fournisseur;
DROP TABLE IF EXISTS compte_comptable;
