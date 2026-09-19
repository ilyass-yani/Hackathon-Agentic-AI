-- Up Migration

-- Choix transversal : BIGSERIAL pour toutes les PK (id purement internes, jamais
-- exposés/générés côté client, pas besoin d'UUID) ; cohérent sur tout le schéma.

-- Toutes les tables ci-dessous ont created_at/updated_at en TIMESTAMPTZ avec défaut
-- now(). Un défaut ne rafraîchit updated_at qu'à l'insertion ; le trigger générique
-- ci-dessous le remet à jour à chaque UPDATE, sinon la colonne resterait figée sur
-- sa valeur d'insertion et perdrait son sens.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────────
-- documents
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE documents (
  id                BIGSERIAL PRIMARY KEY,
  -- Format libre (pdf, jpg, xlsx, ...) : les formats supportés peuvent évoluer,
  -- pas de CHECK ici (contrairement à statut_traitement qui est un état métier fermé).
  type              TEXT NOT NULL,
  chemin_fichier    TEXT NOT NULL,
  statut_traitement TEXT NOT NULL DEFAULT 'en_attente'
                    CHECK (statut_traitement IN ('en_attente', 'traite', 'a_verifier', 'non_traite')),
  -- Rempli seulement si le traitement n'a pas abouti à 'traite'.
  motif_echec       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT motif_echec_only_if_not_traite
    CHECK (statut_traitement <> 'traite' OR motif_echec IS NULL)
);

CREATE INDEX idx_documents_statut_traitement ON documents (statut_traitement);

CREATE TRIGGER trg_documents_set_updated_at
BEFORE UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- extraction
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE extraction (
  id                      BIGSERIAL PRIMARY KEY,
  -- UNIQUE : un document a au plus une extraction. ON DELETE CASCADE : une
  -- extraction n'a aucun sens sans son document (donnée dérivée, pas une entité
  -- indépendante) ; supprimer le document doit supprimer son extraction.
  document_id             BIGINT NOT NULL UNIQUE REFERENCES documents (id) ON DELETE CASCADE,
  tiers                   TEXT,
  date                    DATE,
  ht                      NUMERIC(14, 2),
  tva                     NUMERIC(14, 2),
  ttc                     NUMERIC(14, 2),
  taux_tva                NUMERIC(5, 2),
  numero_piece            TEXT,
  ice_fournisseur         TEXT,
  ice_client              TEXT,
  confiance               NUMERIC(3, 2) CHECK (confiance IS NULL OR (confiance >= 0 AND confiance <= 1)),
  -- Variance de Laplacien post-recadrage : pas de borne haute connue a priori, pas de CHECK.
  score_nettete           NUMERIC,
  nombre_appels_llm       SMALLINT NOT NULL DEFAULT 1 CHECK (nombre_appels_llm IN (0, 1, 2)),
  -- Deuxième lecture brute (cf. pipeline à double lecture) conservée pour comparaison
  -- humaine quand le document est 'a_verifier' ; jamais utilisée pour trancher automatiquement.
  extraction_alternative  JSONB,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_extraction_set_updated_at
BEFORE UPDATE ON extraction
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- releve_ligne
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE releve_ligne (
  id            BIGSERIAL PRIMARY KEY,
  date          DATE NOT NULL,
  libelle       TEXT NOT NULL,
  debit         NUMERIC(14, 2),
  credit        NUMERIC(14, 2),
  solde         NUMERIC(14, 2),
  -- Catégorie best-effort ('salaire', 'frais_bancaire', 'reglement_client', 'facture', ...)
  -- utilisée pour filtrer les lignes à ignorer côté rapprochement ; liste non figée
  -- (comme documents.type), donc pas de CHECK contrairement aux colonnes de statut fermées.
  type_detecte  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Une ligne de relevé a un débit OU un crédit, jamais les deux, jamais aucun.
  CONSTRAINT releve_ligne_debit_xor_credit
    CHECK ((debit IS NOT NULL AND credit IS NULL) OR (debit IS NULL AND credit IS NOT NULL))
);

CREATE TRIGGER trg_releve_ligne_set_updated_at
BEFORE UPDATE ON releve_ligne
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- rapprochement
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE rapprochement (
  id          BIGSERIAL PRIMARY KEY,
  statut      TEXT NOT NULL CHECK (statut IN ('rapproche', 'partiel', 'non_rapproche')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_rapprochement_set_updated_at
BEFORE UPDATE ON rapprochement
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- rapprochement_ligne (table de jonction N:N document <-> releve_ligne, portée
-- par un rapprochement)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE rapprochement_ligne (
  id                BIGSERIAL PRIMARY KEY,
  -- Le détail n'a pas de sens sans son rapprochement parent : CASCADE.
  rapprochement_id  BIGINT NOT NULL REFERENCES rapprochement (id) ON DELETE CASCADE,
  -- document_id / releve_ligne_id : RESTRICT, pas CASCADE. Contrairement à
  -- extraction/anomalie, ces lignes constituent une piste d'audit financier
  -- (quel paiement couvre quelle facture, pour quel montant). Supprimer un
  -- document ou une ligne bancaire déjà rapprochée ne doit pas effacer
  -- silencieusement cet historique ; il faut explicitement défaire le
  -- rapprochement avant de pouvoir supprimer la donnée source.
  document_id       BIGINT NOT NULL REFERENCES documents (id) ON DELETE RESTRICT,
  releve_ligne_id   BIGINT NOT NULL REFERENCES releve_ligne (id) ON DELETE RESTRICT,
  -- Part du montant de la ligne bancaire imputée à cette facture (paiements groupés/partiels).
  montant_impute    NUMERIC(14, 2) NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rapprochement_ligne_rapprochement_id ON rapprochement_ligne (rapprochement_id);
CREATE INDEX idx_rapprochement_ligne_document_id ON rapprochement_ligne (document_id);
CREATE INDEX idx_rapprochement_ligne_releve_ligne_id ON rapprochement_ligne (releve_ligne_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- anomalie
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE anomalie (
  id                  BIGSERIAL PRIMARY KEY,
  type                TEXT NOT NULL
                      CHECK (type IN ('doublon', 'tva_erronee', 'hors_periode', 'tiers_inconnu', 'montant_aberrant')),
  -- Une anomalie n'a aucun sens sans le document qu'elle qualifie : CASCADE,
  -- même raisonnement que pour extraction.
  document_id         BIGINT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  -- Calculé par le code (jamais par le LLM) : montant financier exposé par l'anomalie.
  montant_exposition  NUMERIC(14, 2) NOT NULL,
  confiance           NUMERIC(3, 2) CHECK (confiance IS NULL OR (confiance >= 0 AND confiance <= 1)),
  statut_revue        TEXT NOT NULL DEFAULT 'en_attente'
                      CHECK (statut_revue IN ('en_attente', 'validee', 'rejetee')),
  motif               TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_anomalie_document_id ON anomalie (document_id);
CREATE INDEX idx_anomalie_statut_revue ON anomalie (statut_revue);

CREATE TRIGGER trg_anomalie_set_updated_at
BEFORE UPDATE ON anomalie
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- decision_humaine
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE decision_humaine (
  id            BIGSERIAL PRIMARY KEY,
  -- Une décision n'a aucun sens sans l'anomalie qu'elle tranche : CASCADE.
  anomalie_id   BIGINT NOT NULL REFERENCES anomalie (id) ON DELETE CASCADE,
  action        TEXT NOT NULL CHECK (action IN ('validee', 'rejetee')),
  horodatage    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Pas de updated_at : une décision est un événement d'audit immuable, pas un
  -- enregistrement mutable (on ne "modifie" pas une décision passée, on en crée
  -- une nouvelle si besoin).
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_decision_humaine_anomalie_id ON decision_humaine (anomalie_id);

-- Down Migration

DROP TABLE IF EXISTS decision_humaine;
DROP TABLE IF EXISTS anomalie;
DROP TABLE IF EXISTS rapprochement_ligne;
DROP TABLE IF EXISTS rapprochement;
DROP TABLE IF EXISTS releve_ligne;
DROP TABLE IF EXISTS extraction;
DROP TABLE IF EXISTS documents;
DROP FUNCTION IF EXISTS set_updated_at();
