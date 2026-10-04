import { config } from '../config';
import { CATEGORIES, SEVERITIES, type Category, type Severity } from '../domain';

export interface Suggestion {
  title: string;
  description: string;
  category: Category;
  severity: Severity;
  source: 'ai' | 'heuristic';
}

const KEYWORDS: [Category, RegExp][] = [
  ['fire_safety', /\b(fire|smoke|alarm|sprinkler|extinguisher|exit)\b/i],
  ['plumbing_leak', /\b(leak|leaking|water|flood|pipe|drain|sewage|dripping|damp|seepage)\b/i],
  ['electrical', /\b(electric|power|light|lights|bulb|socket|wiring|spark|outage|lamp)\b/i],
  ['lift', /\b(lift|elevator)\b/i],
  ['hvac_ac', /\b(ac|a\/c|air.?con|hvac|cooling|chiller|fan coil|ventilation)\b/i],
  ['pests', /\b(pest|cockroach|rat|rats|mouse|ants|insects|bugs|termite|bedbug)\b/i],
  ['waste', /\b(garbage|trash|rubbish|bin|bins|waste|chute|smell|odou?r)\b/i],
  ['cleaning', /\b(dirty|clean|cleaning|dust|stain|spill)\b/i],
  ['parking', /\b(park|parking|car park|basement|valet|blocked)\b/i],
  ['pool_gym', /\b(pool|gym|sauna|jacuzzi|treadmill|steam)\b/i],
  ['security', /\b(security|gate|cctv|intruder|access card|fob|barrier|lock)\b/i],
  ['noise', /\b(noise|noisy|loud|drilling|construction|music)\b/i],
  ['landscaping', /\b(garden|plants|grass|tree|landscap|irrigation|sprinkler)\b/i],
  ['structural', /\b(crack|ceiling|wall|tiles?|paint|cladding|façade|facade|balcony|door|window)\b/i],
  ['common_area', /\b(lobby|corridor|hallway|stairs?|staircase|reception|common)\b/i],
];

/** Free, instant fallback so the form is pre-filled even with AI switched off. */
export function heuristicSuggestion(note: string): Suggestion {
  const clean = note.trim().replace(/\s+/g, ' ');
  const firstSentence = clean.split(/(?<=[.!?])\s/)[0] ?? '';
  const title = firstSentence.length > 70 ? `${firstSentence.slice(0, 67).trimEnd()}...` : firstSentence;
  const category = KEYWORDS.find(([, re]) => re.test(clean))?.[0] ?? 'other';
  const severity: Severity = /\b(urgent|danger|dangerous|unsafe|sparks?|flood(ing)?|fire|smoke|trapped|exposed wires?)\b/i.test(clean) ? 'high' : 'normal';
  return { title: title || 'Issue reported with photo', description: clean, category, severity, source: 'heuristic' };
}

const SYSTEM = `You help residents of a Dubai apartment community report maintenance issues to property management.
Look at the photo and the resident's optional note. Respond with ONLY a JSON object:
{"title": string (max 70 chars, specific, no ref numbers),
 "description": string (max 280 chars, factual, what is visible and where if stated),
 "category": one of ${CATEGORIES.join(' | ')},
 "severity": one of ${SEVERITIES.join(' | ')}}
Use "urgent" only for immediate danger to people. Do not identify or describe people, faces or number plates. If the photo is unclear, rely on the note.`;

/** One small vision call per report - a ~1k px image is roughly a thousand input tokens on a Haiku-class model. */
export async function suggestFromPhoto(image: Buffer, note: string): Promise<Suggestion> {
  const fallback = heuristicSuggestion(note);
  if (!config.ai.apiKey) return fallback;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': config.ai.apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        model: config.ai.model,
        max_tokens: 400,
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.toString('base64') } },
              { type: 'text', text: note.trim() ? `Resident's note: ${note.trim().slice(0, 600)}` : 'No note provided.' },
            ],
          },
        ],
      }),
    });
    if (!res.ok) return fallback;
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = data.content?.find((c) => c.type === 'text')?.text ?? '';
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const category = (CATEGORIES as readonly string[]).includes(json.category) ? (json.category as Category) : fallback.category;
    const severity = (SEVERITIES as readonly string[]).includes(json.severity) ? (json.severity as Severity) : 'normal';
    return {
      title: String(json.title ?? fallback.title).slice(0, 80),
      description: String(json.description ?? fallback.description).slice(0, 400),
      category,
      severity,
      source: 'ai',
    };
  } catch {
    return fallback;
  }
}
