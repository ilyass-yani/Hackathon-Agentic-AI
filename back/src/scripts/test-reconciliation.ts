// Tests manuels de back/src/lib/reconciliation.ts — pas de framework, cas à la main,
// pour valider la logique avant de la brancher sur les vraies données du batch.
// Fonction pure testée en isolation : aucun accès Postgres ici.

import { Decimal } from 'decimal.js';
import { rapprocher, type FactureCandidate, type ResultatRapprochement } from '../lib/reconciliation.js';

let total = 0;
let ok = 0;

function verifier(nom: string, resultat: ResultatRapprochement, attendu: Partial<ResultatRapprochement>): void {
  total += 1;
  const erreurs: string[] = [];

  if (attendu.statut !== undefined && resultat.statut !== attendu.statut) {
    erreurs.push(`statut attendu=${attendu.statut} obtenu=${resultat.statut}`);
  }
  if (attendu.documentIds !== undefined) {
    const a = [...attendu.documentIds].sort((x, y) => x - y);
    const b = [...resultat.documentIds].sort((x, y) => x - y);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      erreurs.push(`documentIds attendu=[${a}] obtenu=[${b}]`);
    }
  }
  if (attendu.soldeRestant !== undefined) {
    const attenduOk =
      attendu.soldeRestant === null
        ? resultat.soldeRestant === null
        : resultat.soldeRestant !== null && resultat.soldeRestant.equals(attendu.soldeRestant);
    if (!attenduOk) {
      erreurs.push(
        `soldeRestant attendu=${attendu.soldeRestant?.toString() ?? 'null'} obtenu=${resultat.soldeRestant?.toString() ?? 'null'}`,
      );
    }
  }

  if (erreurs.length === 0) {
    ok += 1;
    console.log(`✓ PASS : ${nom}`);
  } else {
    console.log(`✗ FAIL : ${nom}`);
    for (const e of erreurs) console.log(`    - ${e}`);
  }
  console.log(
    `    statut=${resultat.statut} documentIds=[${resultat.documentIds}] soldeRestant=${resultat.soldeRestant?.toString() ?? 'null'}`,
  );
}

function facture(documentId: number, date: string, ttc: string): FactureCandidate {
  return { documentId, date: new Date(date), ttc: new Decimal(ttc) };
}

// --- Cas 1 : match simple, une seule facture, dans la fenêtre ---
{
  const factures = [facture(1, '2026-03-01', '21639.47')];
  const resultat = rapprocher('SOMAFER SARL', new Decimal('21639.47'), new Date('2026-03-15'), factures);
  verifier('match simple (1 facture, montant exact)', resultat, {
    statut: 'rapproche',
    documentIds: [1],
    soldeRestant: null,
  });
}

// --- Cas 2 : paiement groupé, 2 factures dont la somme égale le montant ---
{
  const factures = [
    facture(2, '2026-03-01', '10000.00'),
    facture(3, '2026-03-05', '15000.00'),
    facture(4, '2026-03-10', '999999.99'), // distracteur, ne doit pas être inclus
  ];
  const resultat = rapprocher('BUREAU VERITAS MAROC', new Decimal('25000.00'), new Date('2026-03-20'), factures);
  verifier('paiement groupé (2 factures, somme exacte)', resultat, {
    statut: 'rapproche',
    documentIds: [2, 3],
    soldeRestant: null,
  });
}

// --- Cas 3 : facture hors fenêtre de 60 jours -> doit échouer (non_rapproche) ---
{
  // Facture au 2026-01-01, ligne bancaire au 2026-03-15 : 73 jours d'écart, > 60.
  // Le montant matcherait exactement si la fenêtre n'était pas respectée — donc si
  // le test passe en non_rapproche, c'est bien le filtre de fenêtre qui a joué,
  // pas un hasard de montant.
  const factures = [facture(5, '2026-01-01', '5000.00')];
  const resultat = rapprocher('AGRIFOOD SOUSS', new Decimal('5000.00'), new Date('2026-03-15'), factures);
  verifier('hors fenêtre 60 jours (73 jours d\'écart) -> non_rapproche', resultat, {
    statut: 'non_rapproche',
    documentIds: [],
    soldeRestant: null,
  });
}

// --- Cas 3bis : même écart mais dans la fenêtre (60 jours pile) -> doit matcher ---
{
  const factures = [facture(6, '2026-01-15', '5000.00')];
  const resultat = rapprocher('AGRIFOOD SOUSS', new Decimal('5000.00'), new Date('2026-03-16'), factures);
  verifier('exactement 60 jours d\'écart (limite incluse) -> rapproche', resultat, {
    statut: 'rapproche',
    documentIds: [6],
    soldeRestant: null,
  });
}

// --- Cas 4 : montant partiel, inférieur au TTC d'une facture ---
{
  const factures = [facture(7, '2026-03-01', '10000.00')];
  const resultat = rapprocher('CABINET FIDAROC', new Decimal('6000.00'), new Date('2026-03-15'), factures);
  verifier('paiement partiel (6000 sur facture de 10000)', resultat, {
    statut: 'partiel',
    documentIds: [7],
    soldeRestant: new Decimal('4000.00'),
  });
}

console.log(`\n=== Résumé : ${ok}/${total} tests passés ===`);
if (ok !== total) {
  process.exit(1);
}
