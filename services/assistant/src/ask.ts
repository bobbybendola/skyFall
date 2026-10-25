// One grounded answer. The snapshot is the only source of numbers. No tools are
// attached. The old search_parameters field is rejected with HTTP 410
// ("Live search is deprecated"), so it must not be sent.

import type { Snapshot } from './snapshot.ts';

export const RULES = [
  'You are SKYFALL\'s re-entry assistant on a demo screen.',
  'Answer only from the JSON snapshot in this message. It was read from SpacetimeDB tables moments ago.',
  'Do not invent numbers, names, times, places, or probabilities. If the snapshot does not contain a fact, say the tables do not have it.',
  'For "what is coming down", use summary.next_24h or summary.next_72h. An empty list means none, not that you are unsure. Quote median_reentry_utc and the q05–q95 window. Times are UTC.',
  'Never state a single landing point or a single impact time as certain. Give the 90% area and call impact_lat/impact_lon a modeled sample.',
  'Call every debris mass, survival chance, energy, and area a modeled estimate, and name the archetype_id.',
  'Do not say falling debris is safe to approach. If asked about touching a piece, say do not touch it and contact local authorities.',
  'If source or status is REPLAY, call that row a historical replay, not a live prediction.',
  'Off-topic questions get one sentence pointing back at the re-entries in the snapshot.',
  'Keep the answer under 120 words.',
].join(' ');

export type ChatTurn = { role: 'system' | 'user' | 'assistant'; content: string };

export function messagesFor(snapshot: Snapshot, question: string, history: ChatTurn[]): ChatTurn[] {
  const prior = history.slice(-6).map(turn => ({
    role: turn.role,
    content: turn.content.slice(0, 2000),
  }));
  return [
    { role: 'system', content: `${RULES}\n\nSNAPSHOT:\n${JSON.stringify(snapshot)}` },
    ...prior,
    { role: 'user', content: question },
  ];
}

export function grokBody(model: string, messages: ChatTurn[]): Record<string, unknown> {
  return {
    model,
    messages,
    stream: false,
    temperature: 0.2,
    max_completion_tokens: 700,
    reasoning_effort: 'low',
  };
}

export async function completeWithGrok(model: string, apiKey: string, messages: ChatTurn[]): Promise<string> {
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(grokBody(model, messages)),
    signal: AbortSignal.timeout(45_000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`grok HTTP ${res.status}: ${raw.slice(0, 180)}`);
  let body: { choices?: { message?: { content?: string | null; refusal?: string | null } }[] };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    throw new Error('grok returned invalid JSON');
  }
  const message = body.choices?.[0]?.message;
  const content = message?.content?.trim() ?? '';
  if (!content) {
    throw new Error(message?.refusal ? `grok refusal: ${message.refusal.slice(0, 160)}` : 'grok returned an empty answer');
  }
  return content;
}
