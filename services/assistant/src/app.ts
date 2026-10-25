// HTTP surface: GET /health, POST /ask. No key and no database writes.
// A missing key is "assistant offline" so the globe can keep running.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { messagesFor, type ChatTurn } from './ask.ts';
import { buildSnapshot, dataMode, type Tables } from './snapshot.ts';

export type AssistantDeps = {
  hasKey: boolean;
  model: string;
  now: () => Date;
  loadTables: () => Promise<Tables>;
  complete: (messages: ChatTurn[]) => Promise<string>;
};

const QUESTION_MAX = 500;

type AskBody = {
  question?: unknown;
  history?: unknown;
};

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  });
  res.end(json);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32_000) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function historyOf(value: unknown): ChatTurn[] {
  if (!Array.isArray(value)) return [];
  const turns: ChatTurn[] = [];
  for (const item of value.slice(-6)) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { role?: unknown; text?: unknown; content?: unknown };
    const role = row.role === 'assistant' ? 'assistant' : row.role === 'user' ? 'user' : null;
    const text = typeof row.text === 'string' ? row.text : typeof row.content === 'string' ? row.content : '';
    if (!role || !text.trim()) continue;
    turns.push({ role, content: text.trim().slice(0, 2000) });
  }
  return turns;
}

export async function handle(deps: AssistantDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'OPTIONS') {
    send(res, 204, {});
    return;
  }
  const path = (req.url ?? '/').split('?')[0];
  if (req.method === 'GET' && path === '/health') {
    send(res, 200, { ok: true, grok: deps.hasKey, model: deps.hasKey ? deps.model : null });
    return;
  }
  if (req.method !== 'POST' || path !== '/ask') {
    send(res, 404, { error: 'not found' });
    return;
  }
  let body: AskBody;
  try {
    body = JSON.parse(await readBody(req)) as AskBody;
  } catch {
    send(res, 400, { error: 'expected JSON' });
    return;
  }
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) {
    send(res, 400, { error: 'question is required' });
    return;
  }
  if (question.length > QUESTION_MAX) {
    send(res, 400, { error: `question must be ${QUESTION_MAX} characters or fewer` });
    return;
  }
  if (!deps.hasKey) {
    send(res, 503, { error: 'assistant offline', reason: 'no_key' });
    return;
  }
  let tables: Tables;
  try {
    tables = await deps.loadTables();
  } catch (err) {
    send(res, 503, { error: 'assistant offline', reason: 'db', detail: String(err).slice(0, 180) });
    return;
  }
  const history = historyOf(body.history);
  const snapshot = buildSnapshot(tables, deps.now());
  try {
    const text = (await deps.complete(messagesFor(snapshot, question, history))).trim();
    if (!text) throw new Error('empty answer');
    send(res, 200, {
      answer: text,
      data_mode: dataMode(snapshot),
      empty_tables: snapshot.summary.empty_tables,
      model: deps.model,
    });
  } catch (err) {
    send(res, 503, { error: 'assistant offline', reason: 'grok', detail: String(err).slice(0, 180) });
  }
}
