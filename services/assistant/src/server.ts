// SKYFALL assistant. Stateless HTTP: read public SpacetimeDB tables, ask Grok,
// return the text. The xAI key stays in this process. Nothing is written back.
//
//   cd services/assistant && npm start
//   GET /health    { ok, grok }
//   POST /ask      { question } -> { answer, data_mode, empty_tables }

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { completeWithGrok } from './ask.ts';
import { handle, type AssistantDeps } from './app.ts';
import { httpBase, loadTables, runSql } from './queries.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
for (const file of [join(here, '..', '.env'), join(root, '.env')]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

const key = process.env.XAI_API_KEY?.trim() || '';
const model = process.env.XAI_MODEL?.trim() || 'grok-4.7';
const port = Number(process.env.ASSISTANT_PORT || 8787);
const host = process.env.ASSISTANT_HOST?.trim() || '127.0.0.1';
const uri = process.env.SPACETIMEDB_URI || 'wss://maincloud.spacetimedb.com';
const database = process.env.SPACETIMEDB_MODULE || 'skyfall-calhacks';
const token = process.env.ASSISTANT_TOKEN?.trim() || undefined;
const base = httpBase(uri);

const deps: AssistantDeps = {
  hasKey: key.length > 0,
  model,
  now: () => new Date(),
  loadTables: () => loadTables(query => runSql(base, database, query, token)),
  complete: messages => completeWithGrok(model, key, messages),
};

const server = createServer((req, res) => {
  handle(deps, req, res).catch(err => {
    if (res.headersSent) return;
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'assistant offline', reason: 'internal', detail: String(err).slice(0, 180) }));
  });
});

server.listen(port, host, () => {
  console.log(
    `[assistant] http://${host}:${port}  db=${database}  grok=${deps.hasKey ? model : 'NO KEY (offline)'}`
  );
});
