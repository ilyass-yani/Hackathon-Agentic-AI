# Hackathon-Agentic-AI
Yani Ilyass 0 branch travail solitaire

installation et lancement : 
    mkdir -p back/src/agents back/src/lib back/src/db/migrations back/src/routes
    cd back
    npm init -y
    npm install fastify @langchain/langgraph @langchain/core decimal.js pg ioredis bullmq dotenv
    npm install -D typescript tsx @types/node @types/pg
    npx tsc --init
    cd ..
    npm create vite@latest front -- --template react-ts
    cd front
    npm install
    cd ..
    


test docker pour worker.ts et server.ts:
        docker compose up -d --build
        docker compose ps                          # les 5 services doivent être Up/healthy

        curl http://localhost:3000/health          # {"status":"ok"}
        curl http://localhost:3000/health/db       # {"status":"ok"}
        curl http://localhost:3000/health/redis    # {"status":"ok"}
        curl http://localhost:3000/health/queue    # {"status":"ok","queue":"documents","counts":{...}}

        # Preuve de bout en bout server <-> worker via Redis :
        docker compose exec -T api node -e "
        const { Queue } = require('bullmq');
        const q = new Queue('documents', { connection: { host: 'redis', port: 6379, maxRetriesPerRequest: null } });
        q.add('test-job', { hello: 'world' }).then(j => { console.log('job', j.id); process.exit(0); });
        "
        docker compose logs worker --tail 5        # doit montrer "Job reçu" puis "Job terminé"
        curl http://localhost:3000/health/queue    # "completed" doit avoir augmenté de 1

        docker compose down                        # arrêt propre, pas d'erreur SIGTERM

premier test de l'ocr 
npx tsx src/scripts/test-ocr.ts "../../sujet-03-chiffra/factures/DOC-060.pdf"
npx tsx src/scripts/test-ocr.ts "../../sujet-03-chiffra/factures/DOC-061.jpg"
npx tsx src/scripts/test-ocr.ts "../../sujet-03-chiffra/factures"



installation pour migration postgres sql pur 
cd back 
npm install --save-dev node-pg-migrate



cd back
npm install @langchain/langgraph-checkpoint-postgres