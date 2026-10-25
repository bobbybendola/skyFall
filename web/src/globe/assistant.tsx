// Text chat over services/assistant. If that process or XAI_API_KEY is missing,
// the button says "assistant offline" and the globe keeps working.
import { useEffect, useState } from 'react';

type Phase = 'checking' | 'ready' | 'offline';
type Msg = { role: 'user' | 'assistant'; text: string };

const BASE = (import.meta.env.VITE_ASSISTANT_URL || '/api/assistant').replace(/\/$/, '');

const PROMPTS = [
  "What's coming down in the next 24 hours?",
  'Will any debris survive from the next object?',
  'Where will it land?',
];

async function health(): Promise<Phase> {
  const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) return 'offline';
  const body = (await res.json()) as { ok?: boolean; grok?: boolean };
  return body.ok && body.grok ? 'ready' : 'offline';
}

export function AssistantPanel() {
  const [phase, setPhase] = useState<Phase>('checking');
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);

  useEffect(() => {
    let live = true;
    health()
      .then(next => {
        if (live) setPhase(next);
      })
      .catch(() => {
        if (live) setPhase('offline');
      });
    return () => {
      live = false;
    };
  }, []);

  async function send(question: string) {
    const text = question.trim();
    if (!text || pending || phase !== 'ready') return;
    const history = msgs.map(m => ({ role: m.role, text: m.text }));
    setMsgs(prev => [...prev, { role: 'user', text }]);
    setDraft('');
    setPending(true);
    try {
      const res = await fetch(`${BASE}/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: text, history }),
        signal: AbortSignal.timeout(50_000),
      });
      const body = (await res.json()) as { answer?: string; error?: string; reason?: string; data_mode?: string };
      if (!res.ok || !body.answer) {
        if (body.reason === 'no_key') setPhase('offline');
        const why =
          body.reason === 'db'
            ? 'Could not read SpacetimeDB. The globe is unaffected.'
            : body.reason === 'grok'
              ? 'Grok did not answer. Try again in a moment.'
              : 'Assistant offline.';
        setMsgs(prev => [...prev, { role: 'assistant', text: why }]);
        return;
      }
      const mode = body.data_mode === 'MIXED' || body.data_mode === 'SIM' ? '\n\nIncludes replay rows, labeled simulated.' : '';
      setMsgs(prev => [...prev, { role: 'assistant', text: `${body.answer}${mode}` }]);
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      setMsgs(prev => [
        ...prev,
        { role: 'assistant', text: timedOut ? 'Grok took too long. Try again.' : 'Assistant offline.' },
      ]);
      if (!timedOut) setPhase('offline');
    } finally {
      setPending(false);
    }
  }

  const label = phase === 'offline' ? 'assistant offline' : 'Ask Grok';
  // Stay hidden until /health returns, so a missing key never flashes "Ask Grok".
  if (phase === 'checking') return null;

  return (
    <div className="globe-ask">
      <button
        type="button"
        className={phase === 'offline' ? 'offline' : ''}
        aria-expanded={open}
        aria-controls="skyfall-ask"
        onClick={() => setOpen(v => !v)}
      >
        {label}
      </button>
      {open && (
        <section id="skyfall-ask" className="globe-chat" aria-label="Re-entry assistant">
          <p className="muted">Answers use the live tables only. Debris figures are modeled estimates.</p>
          {phase === 'offline' && (
            <p>The assistant service is not running, or XAI_API_KEY is not set. The globe is unaffected.</p>
          )}
          {phase === 'ready' && (
            <div className="prompts">
              {PROMPTS.map(prompt => (
                <button key={prompt} type="button" onClick={() => void send(prompt)} disabled={pending}>
                  {prompt}
                </button>
              ))}
            </div>
          )}
          {msgs.map((m, i) => (
            <p key={`${m.role}-${i}`} className={m.role === 'user' ? 'user' : 'assistant'}>
              {m.text}
            </p>
          ))}
          {pending && <p className="muted">Reading the tables…</p>}
          {phase === 'ready' && (
            <form
              onSubmit={event => {
                event.preventDefault();
                void send(draft);
              }}
            >
              <input
                aria-label="Question about re-entries"
                value={draft}
                maxLength={500}
                placeholder="Ask about a re-entry"
                onChange={event => setDraft(event.target.value)}
              />
              <button type="submit" disabled={pending || draft.trim().length === 0}>
                Ask
              </button>
            </form>
          )}
        </section>
      )}
    </div>
  );
}
