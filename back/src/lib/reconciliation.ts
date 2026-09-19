import { Decimal } from 'decimal.js';

// Toutes les règles citées ci-dessous viennent de sujet-03-chiffra/regles-fiscales.md
// (section "Rapprochement bancaire", règles 9-12) — c'est le référentiel qui fait foi,
// rien n'est supposé.

// Règle 9 : un paiement peut intervenir jusqu'à 60 jours APRÈS la date de facture.
const FENETRE_JOURS = 60;

const TOLERANCE = new Decimal('0.01');

// Pas une règle du sujet — choix pragmatique assumé pour borner la recherche de
// combinaisons de paiement groupé (règle 10). À réviser si un cas réel dépasse
// 6 factures regroupées dans une même ligne bancaire.
const TAILLE_MAX_COMBINAISON = 6;

export interface FactureCandidate {
  documentId: number;
  date: Date;
  ttc: Decimal;
}

export type StatutRapprochement = 'rapproche' | 'partiel' | 'non_rapproche';

export interface MontantImpute {
  documentId: number;
  montant: Decimal;
}

export interface ResultatRapprochement {
  statut: StatutRapprochement;
  documentIds: number[];
  montantImpute: MontantImpute[];
  // Renseigné uniquement si statut === 'partiel' (règle 11).
  soldeRestant: Decimal | null;
}

function joursEcoules(dateLigne: Date, dateFacture: Date): number {
  const msParJour = 1000 * 60 * 60 * 24;
  return Math.round((dateLigne.getTime() - dateFacture.getTime()) / msParJour);
}

// Règle 9 : fenêtre de 60 jours après la facture, jamais avant — une ligne bancaire
// ne peut pas payer une facture future (jours négatifs = facture postérieure à la
// ligne, exclue).
function filtrerFenetre(factures: FactureCandidate[], dateLigne: Date): FactureCandidate[] {
  return factures.filter((f) => {
    const jours = joursEcoules(dateLigne, f.date);
    return jours >= 0 && jours <= FENETRE_JOURS;
  });
}

function combinaisons<T>(items: T[], taille: number): T[][] {
  if (taille === 0) return [[]];
  if (items.length < taille) return [];
  const [premier, ...reste] = items;
  const avecPremier = combinaisons(reste, taille - 1).map((c) => [premier as T, ...c]);
  const sansPremier = combinaisons(reste, taille);
  return [...avecPremier, ...sansPremier];
}

/**
 * Rapprochement bancaire pur (zéro I/O, zéro appel LLM) : rien n'est "matché à
 * l'impression", tout est vérifiable en relisant ce fichier. `factures` est supposé
 * déjà filtré par fournisseur par l'appelant (cette fonction ne fait aucune requête) ;
 * `fournisseurNom` n'est pas utilisé pour filtrer ici, gardé dans la signature pour la
 * traçabilité côté appelant (logs, messages d'erreur amont).
 */
export function rapprocher(
  fournisseurNom: string,
  montantLigne: Decimal,
  dateLigne: Date,
  factures: FactureCandidate[],
): ResultatRapprochement {
  const candidats = filtrerFenetre(factures, dateLigne);

  // 1. Match exact à une seule facture. En cas d'ambiguïté (plusieurs factures
  // matchent individuellement), on prend la première dans l'ordre reçu — pas de
  // règle du sujet pour trancher, choix pragmatique documenté.
  const matchUnique = candidats.find((f) => f.ttc.minus(montantLigne).abs().lessThanOrEqualTo(TOLERANCE));
  if (matchUnique) {
    return {
      statut: 'rapproche',
      documentIds: [matchUnique.documentId],
      montantImpute: [{ documentId: matchUnique.documentId, montant: matchUnique.ttc }],
      soldeRestant: null,
    };
  }

  // 2. Paiement groupé (règle 10) : combinaison de 2 à TAILLE_MAX_COMBINAISON
  // factures dont la somme égale le montant de la ligne.
  for (let taille = 2; taille <= TAILLE_MAX_COMBINAISON; taille += 1) {
    for (const combo of combinaisons(candidats, taille)) {
      const somme = combo.reduce((acc, f) => acc.plus(f.ttc), new Decimal(0));
      if (somme.minus(montantLigne).abs().lessThanOrEqualTo(TOLERANCE)) {
        return {
          statut: 'rapproche',
          documentIds: combo.map((f) => f.documentId),
          montantImpute: combo.map((f) => ({ documentId: f.documentId, montant: f.ttc })),
          soldeRestant: null,
        };
      }
    }
  }

  // 3. Paiement partiel (règle 11) : le montant est strictement inférieur au TTC
  // d'une facture unique candidate (aucun match exact ni combinaison trouvés avant).
  // En cas de plusieurs candidates, on prend celle dont le solde restant serait le
  // plus petit (montant le plus proche du paiement reçu) — pas une règle du sujet,
  // choix pragmatique documenté comme pour le point 1.
  const partielles = candidats
    .filter((f) => montantLigne.lessThan(f.ttc))
    .sort((a, b) => a.ttc.minus(montantLigne).comparedTo(b.ttc.minus(montantLigne)));

  if (partielles.length > 0) {
    const facture = partielles[0]!;
    return {
      statut: 'partiel',
      documentIds: [facture.documentId],
      montantImpute: [{ documentId: facture.documentId, montant: montantLigne }],
      soldeRestant: facture.ttc.minus(montantLigne),
    };
  }

  // 4. Aucun match : résultat normal et honnête, pas une erreur — le sujet demande
  // d'afficher le taux de non-rapproché, pas de le masquer.
  return {
    statut: 'non_rapproche',
    documentIds: [],
    montantImpute: [],
    soldeRestant: null,
  };
}
