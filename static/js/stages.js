// Stage geometry. `ground` is the one solid-from-all-sides platform fighters
// spawn on; `platforms` are pass-through-from-below floaters. `blast` is the
// KO boundary in world space (STAGE_W x STAGE_H, see constants.js).

export const STAGES = [
  {
    id: 'the-deck',
    name: 'The Deck',
    tagline: 'One flat platform. No excuses.',
    bg: '#0a1a14',
    ground: { x: 300, y: 520, w: 680, h: 40 },
    platforms: [],
    blast: { left: -140, right: 1280 + 140, top: -180, bottom: 720 + 160 },
    spawns: [{ x: 470, y: 400 }, { x: 810, y: 400 }],
  },
  {
    id: 'three-tier',
    name: 'Three Tier',
    tagline: 'A main deck and three floaters overhead.',
    bg: '#0a1420',
    ground: { x: 340, y: 560, w: 600, h: 40 },
    platforms: [
      { x: 540, y: 420, w: 200, h: 18 },
      { x: 240, y: 320, w: 190, h: 18 },
      { x: 850, y: 320, w: 190, h: 18 },
    ],
    blast: { left: -140, right: 1280 + 140, top: -220, bottom: 720 + 160 },
    spawns: [{ x: 500, y: 440 }, { x: 780, y: 440 }],
  },
  {
    id: 'the-spire',
    name: 'The Spire',
    tagline: 'Tight blast zones, two side ledges, fast matches.',
    bg: '#160a1e',
    ground: { x: 420, y: 540, w: 440, h: 40 },
    platforms: [
      { x: 300, y: 430, w: 160, h: 18 },
      { x: 820, y: 430, w: 160, h: 18 },
    ],
    blast: { left: -80, right: 1280 + 80, top: -160, bottom: 720 + 120 },
    spawns: [{ x: 560, y: 400 }, { x: 720, y: 400 }],
  },
];

export function getStage(id) {
  return STAGES.find((s) => s.id === id) || STAGES[0];
}
