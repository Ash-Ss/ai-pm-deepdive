/**
 * Resolve free-text place mentions ("Aurangabad", "the Ajanta caves", "Elora")
 * to catalogue IDs. Deterministic on purpose: the LLM only ever passes text,
 * and code decides what it refers to — or that it refers to nothing we know.
 */
import type { Catalogue } from "../catalogue";

export type PlaceMatch = { kind: "city" | "poi"; id: string; name: string; score: number; matched: string };

/** Other names people use. Keys are catalogue IDs. */
const ALIASES: Record<string, string[]> = {
  sambhajinagar: ["aurangabad", "chhatrapati sambhajinagar", "sambhaji nagar", "abad"],
  mumbai: ["bombay"],
  pune: ["poona"],
  csmt: ["cst", "vt", "vt station", "cst station", "victoria terminus", "chhatrapati shivaji terminus"],
  "csmvs-museum": ["prince of wales museum", "csmvs"],
  "gateway-of-india": ["gateway"],
  "haji-ali-dargah": ["haji ali"],
  "siddhivinayak-temple": ["siddhivinayak"],
  "dagdusheth-ganpati": ["dagdusheth"],
  "bibi-ka-maqbara": ["mini taj", "taj of the deccan"],
  "grishneshwar-temple": ["grishneshwar", "ghrishneshwar", "ghushmeshwar"],
  "daulatabad-fort": ["devagiri", "deogiri"],
  "tigers-point": ["tiger point", "tigers leap", "tiger's leap"],
  "mapro-garden": ["mapro"],
};

const MIN_SCORE = 0.75;
const STOPWORDS = new Set(["the", "a", "an", "to", "in", "at", "of", "and"]);

export function normalise(s: string): string {
  return s
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !STOPWORDS.has(w))
    .join(" ");
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** 1 = exact; high when every query word appears (typos allowed) in the candidate. */
function similarity(query: string, candidate: string): number {
  if (query === candidate) return 1;
  const qs = query.split(" ");
  const cs = candidate.split(" ");
  // Each query word must match some candidate word (allowing ~1 typo per 5 letters).
  const wordScore = (q: string) =>
    Math.max(...cs.map((c) => 1 - levenshtein(q, c) / Math.max(q.length, c.length)));
  const perWord = qs.map(wordScore);
  if (perWord.some((s) => s < 0.7)) return 0;
  const avg = perWord.reduce((a, b) => a + b, 0) / perWord.length;
  // Covering more of the candidate's words is a better match ("ajanta caves" > "ajanta").
  const coverage = qs.length / cs.length;
  return Math.round((0.85 * avg + 0.15 * Math.min(1, coverage)) * 1000) / 1000;
}

export function resolvePlace(text: string, catalogue: Catalogue, prefer?: "city" | "poi"): PlaceMatch | null {
  const q = normalise(text);
  if (!q) return null;
  const candidates: { kind: "city" | "poi"; id: string; name: string; labels: string[] }[] = [
    ...catalogue.cities.map((c) => ({ kind: "city" as const, id: c.id, name: c.name, labels: [c.name, c.id, ...(ALIASES[c.id] ?? [])] })),
    ...catalogue.pois.map((p) => ({
      kind: "poi" as const, id: p.id, name: p.name,
      labels: [p.name, p.name.replace(/\(.*?\)/g, ""), p.id.replace(/-/g, " "), ...(ALIASES[p.id] ?? [])],
    })),
  ];
  let best: PlaceMatch | null = null;
  for (const c of candidates) {
    for (const label of c.labels) {
      let score = similarity(q, normalise(label));
      if (prefer && c.kind === prefer) score += 0.01; // tie-break only
      if (!best || score > best.score) best = { kind: c.kind, id: c.id, name: c.name, score, matched: label };
    }
  }
  return best && best.score >= MIN_SCORE ? best : null;
}

export type MentionResolution =
  | { status: "resolved"; match: PlaceMatch }
  | { status: "ambiguous"; options: PlaceMatch[] }
  | { status: "none" };

/** Scores within this of the best count as "equally good" → ask the user. */
const AMBIGUITY_MARGIN = 0.05;

/** Every place (best label per place) that matches, best first. */
export function placeCandidates(text: string, catalogue: Catalogue, prefer?: "city" | "poi"): PlaceMatch[] {
  const q = normalise(text);
  if (!q) return [];
  const best = new Map<string, PlaceMatch>();
  const consider = (kind: "city" | "poi", id: string, name: string, labels: string[]) => {
    for (const label of labels) {
      let score = similarity(q, normalise(label));
      if (prefer && kind === prefer) score += 0.01;
      const key = `${kind}:${id}`;
      if (score >= MIN_SCORE && score > (best.get(key)?.score ?? 0)) best.set(key, { kind, id, name, score, matched: label });
    }
  };
  for (const c of catalogue.cities) consider("city", c.id, c.name, [c.name, c.id, ...(ALIASES[c.id] ?? [])]);
  for (const p of catalogue.pois) consider("poi", p.id, p.name, [p.name, p.name.replace(/\(.*?\)/g, ""), p.id.replace(/-/g, " "), ...(ALIASES[p.id] ?? [])]);
  return [...best.values()].sort((a, b) => b.score - a.score);
}

/**
 * Resolve a mention, or say it's ambiguous ("the fort" → Lohagad, Sinhagad, Pratapgad…)
 * or unknown ("Goa"). An exact name/alias match beats partial matches.
 */
export function resolveMention(text: string, catalogue: Catalogue, prefer?: "city" | "poi"): MentionResolution {
  const all = placeCandidates(text, catalogue, prefer);
  if (all.length === 0) return { status: "none" };
  const [top, second] = all;
  const exact = top.score >= 1 && (!second || second.score < 1);
  if (!second || exact || second.score < top.score - AMBIGUITY_MARGIN) return { status: "resolved", match: top };
  // All equally good options; the caller orders them (e.g. trip cities first) and shows up to 3.
  return { status: "ambiguous", options: all.filter((m) => m.score >= top.score - AMBIGUITY_MARGIN) };
}
