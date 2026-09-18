/**
 * test-llm-connection.ts
 *
 * Script jetable : vérifie que .env contient des credentials LLM valides
 * avant de construire quoi que ce soit dessus.
 *
 * Installation :
 *   npm install dotenv
 *   npm install -D tsx    (ou ts-node)
 *
 * Lancement (depuis la racine du projet, à côté de .env) :
 *   npx tsx test-llm-connection.ts
 */

import 'dotenv/config';

const LLM_URL = process.env.LLM_URL;
const LLM_API_KEY = process.env.LLM_API_KEY;
const LLM_MODEL = process.env.LLM_MODEL;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL;

function assertEnv() {
  const missing = ['LLM_URL', 'LLM_API_KEY', 'LLM_MODEL', 'EMBEDDING_MODEL'].filter(
    (key) => !process.env[key]
  );
  if (missing.length > 0) {
    console.error(`❌ Variables manquantes dans .env : ${missing.join(', ')}`);
    process.exit(1);
  }
}

async function testChatCompletion() {
  console.log('\n--- Test chat completions ---');
  console.log(`POST ${LLM_URL}/chat/completions (model: ${LLM_MODEL})`);

  try {
    const res = await fetch(`${LLM_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [{ role: 'user', content: 'Réponds juste "OK".' }],
        max_completion_tokens: 5,
      }),
    });

    console.log(`Statut HTTP : ${res.status}`);

    if (res.status === 200) {
      const data = await res.json();
      const reply = data.choices?.[0]?.message?.content ?? '(pas de contenu trouvé)';
      console.log(`✅ Connexion OK. Réponse du modèle : "${reply.trim()}"`);
    } else if (res.status === 401 || res.status === 403) {
      console.error('❌ Clé API invalide ou refusée. Vérifie LLM_API_KEY.');
    } else if (res.status === 404) {
      console.error('❌ URL introuvable. Vérifie LLM_URL (chemin /chat/completions).');
    } else {
      const text = await res.text();
      console.error(`❌ Erreur inattendue. Corps de la réponse :\n${text}`);
    }
  } catch (err) {
    console.error('❌ Échec réseau (endpoint injoignable, timeout, DNS...) :', err);
  }
}

async function testEmbeddings() {
  console.log('\n--- Test embeddings ---');
  console.log(`POST ${LLM_URL}/embeddings (model: ${EMBEDDING_MODEL})`);

  try {
    const res = await fetch(`${LLM_URL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: 'test de connexion',
      }),
    });

    console.log(`Statut HTTP : ${res.status}`);

    if (res.status === 200) {
      const data = await res.json();
      const vector = data.data?.[0]?.embedding;
      console.log(`✅ Connexion OK. Vecteur reçu de longueur : ${vector?.length ?? '?'}`);
    } else {
      const text = await res.text();
      console.error(`❌ Erreur (statut ${res.status}). Corps de la réponse :\n${text}`);
    }
  } catch (err) {
    console.error('❌ Échec réseau sur l\'endpoint embeddings :', err);
  }
}

async function main() {
  assertEnv();
  await testChatCompletion();
  await testEmbeddings();
  console.log('\nTerminé.');
}

main();