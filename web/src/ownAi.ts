// Optional "bring your own AI": the resident's key lives only in THIS browser (localStorage)
// and the photo goes from their device straight to the provider they chose. Our server never sees the key.
import { CATEGORY_LABELS } from './api';

export type Provider = 'anthropic' | 'openai';
export interface OwnAi {
  provider: Provider;
  key: string;
}
export interface Draft {
  title: string;
  description: string;
  category: string;
  severity: string;
}

const KEY = 'np_own_ai';
export const MODELS: Record<Provider, string> = { anthropic: 'claude-haiku-4-5-20251001', openai: 'gpt-4o-mini' };

export function loadOwnAi(): OwnAi | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return v && v.key && (v.provider === 'anthropic' || v.provider === 'openai') ? v : null;
  } catch {
    return null;
  }
}
export function saveOwnAi(v: OwnAi | null) {
  try {
    if (v) localStorage.setItem(KEY, JSON.stringify(v));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked */
  }
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

const INSTRUCTION = () =>
  `You help a resident report a building maintenance issue. Look at the photo and note. Reply with ONLY a JSON object: {"title": short title under 70 chars, "description": one or two plain sentences, "category": one of [${Object.keys(CATEGORY_LABELS).join(', ')}], "severity": one of [low, normal, high, urgent]}. Use urgent only for safety risks. Do not identify people or read number plates.`;

function parse(text: string): Draft {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No answer');
  const j = JSON.parse(m[0]);
  const cat = String(j.category ?? '');
  const sev = String(j.severity ?? '');
  return {
    title: String(j.title ?? '').slice(0, 120),
    description: String(j.description ?? '').slice(0, 2000),
    category: cat in CATEGORY_LABELS ? cat : '',
    severity: ['low', 'normal', 'high', 'urgent'].includes(sev) ? sev : 'normal',
  };
}

export async function draftWithOwnAi(cfg: OwnAi, photo: Blob, note: string): Promise<Draft> {
  const b64 = await toBase64(photo);
  const prompt = `${INSTRUCTION()}\nResident's note: ${note || '(none)'}`;
  if (cfg.provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({
        model: MODELS.anthropic,
        max_tokens: 400,
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }, { type: 'text', text: prompt }] }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic error ${res.status}`);
    const j = await res.json();
    return parse(j.content?.[0]?.text ?? '');
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model: MODELS.openai,
      max_tokens: 400,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }] }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI error ${res.status}`);
  const j = await res.json();
  return parse(j.choices?.[0]?.message?.content ?? '');
}
