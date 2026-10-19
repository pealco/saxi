import { cases } from "./benchmark-physical-routing.mjs";
import { drawing, rng } from "./benchmark-routing.mjs";

const point = (x, y) => ({ x, y });

function freshDrawing(kind, n, seed) {
  const random = rng(seed);
  const paths = [];
  for (let i = 0; i < n; i++) {
    if (kind === "islands") {
      const island = i % 12;
      const x = 25 + (island % 4) * 60 + random() * 18;
      const y = 25 + Math.floor(island / 4) * 55 + random() * 18;
      const size = 1 + random() * 4;
      paths.push([point(x, y), point(x + size, y), point(x + size, y + size)]);
    } else if (kind === "ribbons") {
      const row = i % 8;
      const x = 20 + (Math.floor(i / 8) * 240) / Math.ceil(n / 8);
      const y = 25 + row * 20 + 4 * Math.sin(x / 14 + row);
      const dx = 0.3 + random() * 2;
      paths.push([point(x, y), point(x + dx, y + 0.2), point(x + dx * 2, y - 0.4)]);
    } else {
      const island = i % 9;
      const x = 35 + (island % 3) * 80;
      const y = 35 + Math.floor(island / 3) * 65;
      const radius = 2 + (Math.floor(i / 9) % 14) * 0.55;
      const phase = random() * Math.PI * 2;
      const loop = Array.from({ length: 16 }, (_, j) =>
        point(x + radius * Math.cos(phase + (j * Math.PI) / 8), y + radius * Math.sin(phase + (j * Math.PI) / 8)),
      );
      paths.push([...loop, { ...loop[0] }]);
    }
  }
  for (let i = paths.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [paths[i], paths[j]] = [paths[j], paths[i]];
  }
  return paths;
}

export function adaptiveFixtures(phase) {
  const seeds = phase === "adaptive-dev" ? [313, 811] : [9109, 14249];
  const fixtures = [];
  for (const seed of seeds) {
    for (const n of [60, 300])
      for (const kind of ["strokes", "clusters", "hatching", "contours", "fragments", "dots"])
        fixtures.push({ name: `${kind}-${n}-${seed}`, group: "fresh", paths: drawing(kind, n, seed) });
    for (const n of [72, 240])
      for (const kind of ["islands", "ribbons", "nested"])
        fixtures.push({ name: `${kind}-${n}-${seed}`, group: "new-family", paths: freshDrawing(kind, n, seed) });
    for (const n of [1000, 2500])
      for (const kind of ["strokes", "clusters", "dots"])
        fixtures.push({ name: `${kind}-${n}-${seed}`, group: "large", paths: drawing(kind, n, seed) });
  }
  for (const fixture of cases.filter((f) =>
    ["grid-17", "necklace-17", "microdetails", "deliberate-gaps", "repeated-dots"].includes(f.name),
  ))
    fixtures.push({ ...fixture, group: "regression" });
  fixtures.push(
    { name: "empty", paths: [], group: "regression" },
    { name: "singleton", paths: [[point(20, 20)]], group: "regression" },
  );
  return fixtures;
}
