import { drawing, rng } from "./benchmark-routing.mjs";

export function neighborhoodFixtures(phase) {
  const fixtures = [];
  const seeds = phase === "neighborhood-dev" ? [431, 983] : [31139, 51047];
  for (const seed of seeds)
    for (const n of [1500, 3000, 6000])
      for (const scale of [1, 2])
        for (const kind of ["dots", "strokes", "clusters"]) {
          const paths = drawing(kind, n, seed).map((p) => p.map(({ x, y }) => ({ x: x * scale, y: y * scale })));
          fixtures.push({
            name: `${kind}-${n}-${scale === 1 ? "a4" : "a2"}-${seed}`,
            group: "fresh-large",
            paths,
            settings: scale === 2 ? { hardware: "nextdraw-2234" } : {},
          });
        }
  for (const seed of seeds) {
    const random = rng(seed);
    const glyphs = Array.from({ length: 4000 }, (_, i) => {
      const x = 20 + (i % 80) * 6 + random();
      const y = 20 + Math.floor(i / 80) * 6 + random();
      return [
        { x, y },
        { x: x + 0.8, y: y + 0.2 },
        { x: x + 1.2, y: y + 1.1 },
      ];
    });
    for (let i = glyphs.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [glyphs[i], glyphs[j]] = [glyphs[j], glyphs[i]];
    }
    fixtures.push({
      name: `glyphs-4000-a2-${seed}`,
      group: "fresh-large",
      paths: glyphs,
      settings: { hardware: "nextdraw-2234" },
    });
    fixtures.push(
      {
        name: `glyphs-4000-a2-${seed}/fine`,
        group: "large-settings",
        paths: glyphs,
        settings: { hardware: "nextdraw-2234", pointJoinRadius: 0.1, pathJoinRadius: 0.1, minimumPathLength: 0.5 },
      },
      {
        name: `glyphs-4000-a2-${seed}/off`,
        group: "large-settings",
        paths: glyphs,
        settings: { hardware: "nextdraw-2234", sortPaths: false },
      },
    );
    const coarse = fixtures.find((f) => f.name === `strokes-3000-a2-${seed}`);
    fixtures.push({
      ...coarse,
      name: `${coarse.name}/coarse`,
      group: "large-settings",
      settings: { ...coarse.settings, pointJoinRadius: 0.5, pathJoinRadius: 2, minimumPathLength: 2 },
    });
    for (const kind of ["contours", "hatching"])
      fixtures.push({ name: `${kind}-3000-a4-${seed}`, group: "protected-control", paths: drawing(kind, 3000, seed) });
  }
  return fixtures;
}
