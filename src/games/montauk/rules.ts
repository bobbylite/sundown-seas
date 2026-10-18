export interface Tier {
  name: string;
  blurb: string;
  /** Total scupper area in m²: how fast the cockpit drains. */
  scupper: number;
  /** Water on deck (m³) that swamps her. */
  cap: number;
  /** Multiplier on the height of the sea. */
  sea: number;
  /** Multiplier on how hard the fish pull. */
  fish: number;
  score: number;
}

export const TIERS: Tier[] = [
  { name: 'Deckhand', blurb: 'Big freeing ports clear the cockpit fast and the sea is moderate. Fish tire quickly.', scupper: 0.034, cap: 4.6, sea: 0.9, fish: 0.85, score: 0.8 },
  { name: 'Mate', blurb: 'Stock scuppers: a cockpit full of water takes a minute or more to clear. A fair sea.', scupper: 0.02, cap: 3.9, sea: 1.0, fish: 1.0, score: 1 },
  { name: 'Captain', blurb: 'Half-clogged scuppers and a building sea. One bad wave on the beam puts you in trouble.', scupper: 0.012, cap: 3.3, sea: 1.12, fish: 1.15, score: 1.4 },
  { name: 'Legend', blurb: 'Clogged scuppers, the biggest sea and the hardest fish. Every wave counts.', scupper: 0.007, cap: 2.8, sea: 1.25, fish: 1.3, score: 2 },
];

export type SpeciesId = 'striper' | 'bluefish' | 'albie' | 'bluefin';
export interface Species {
  name: string;
  /** Weight range in pounds. */
  lb: [number, number];
  value: number;
  power: number;
  /** Top swimming speed, m/s. */
  speed: number;
  endurance: number;
  /** Chance per second of jumping while thrashing. */
  jump: number;
  bite: number;
  /** Weight of the "sound" mood. */
  sound: number;
  /** How deep it sounds, m. */
  depth: number;
  /** Length factor for the model. */
  len: number;
  teeth?: boolean;
}

export const SPECIES: Record<SpeciesId, Species> = {
  striper: { name: 'Striped Bass', lb: [14, 45], value: 1.0, power: 1.0, speed: 2.4, endurance: 1.0, jump: 0.12, bite: 1.0, sound: 0.35, depth: 14, len: 1.32 },
  bluefish: { name: 'Bluefish', lb: [6, 18], value: 0.9, power: 0.95, speed: 3.0, endurance: 0.8, jump: 0.5, bite: 1.4, sound: 0.1, depth: 8, len: 1.35, teeth: true },
  albie: { name: 'False Albacore', lb: [8, 16], value: 1.4, power: 1.15, speed: 5.2, endurance: 1.1, jump: 0.0, bite: 0.9, sound: 0.25, depth: 18, len: 1.15 },
  bluefin: { name: 'Bluefin Tuna', lb: [70, 240], value: 1.7, power: 1.5, speed: 4.6, endurance: 2.4, jump: 0.0, bite: 0.6, sound: 0.55, depth: 45, len: 1.2 },
};

export type Mood = 'run' | 'sound' | 'circle' | 'thrash' | 'dash' | 'tired';
export const MOODS: Record<Mood, { label: string; cls: string; dur: [number, number] }> = {
  run: { label: 'Running!', cls: '', dur: [4, 9] },
  sound: { label: 'Sounding', cls: '', dur: [5, 10] },
  circle: { label: 'Circling the boat', cls: 'warn', dur: [4, 8] },
  thrash: { label: 'Thrashing!', cls: 'warn', dur: [2, 4] },
  dash: { label: 'Charging the boat! Reel!', cls: 'bad', dur: [1.6, 2.4] },
  tired: { label: 'Tiring', cls: '', dur: [3, 6] },
};

/** 50 lb mono parts at about 230 N; the spool holds 420 m. */
export const LINE_BREAK = 230;
export const SPOOL = 420;
export const BEST_KEY = 'montauk-best';
