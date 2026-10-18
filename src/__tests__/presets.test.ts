import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { defaultPlanOptions } from "../planning.js";
import { presetOptions, validatePresetOptions } from "../preset-options.js";
import { PresetStore, validatePresetName } from "../preset-store.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "saxi-presets-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("presets survive restart and simultaneous saves do not lose settings", async () => {
  const filename = path.join(directory, "settings", "presets.json");
  const store = new PresetStore(filename);
  expect(await store.list()).toEqual([]);
  const options = presetOptions(defaultPlanOptions);
  await Promise.all([store.update("A3 pen", options), store.update("A4 pen", { ...options, penDownHeight: 55 })]);
  const restored = await new PresetStore(filename).list();
  expect(restored.map((preset) => preset.name)).toEqual(["A3 pen", "A4 pen"]);
  expect(restored[1].options.penDownHeight).toBe(55);
});

test("invalid stored data is reported and preserved rather than overwritten", async () => {
  const filename = path.join(directory, "presets.json");
  await writeFile(filename, "broken json");
  const store = new PresetStore(filename);
  await expect(store.update("New", presetOptions(defaultPlanOptions))).rejects.toThrow();
  expect(await readFile(filename, "utf8")).toBe("broken json");
});

test("validate physical settings and strip drawing state and unknown properties", () => {
  const options = presetOptions(defaultPlanOptions);
  expect(validatePresetOptions({ ...options, unexpected: true })).toEqual(options);
  expect(options).not.toHaveProperty("selectedStrokeLayers");
  expect(options).not.toHaveProperty("penHome");
  for (const invalid of [
    { ...options, penDownHeight: -1 },
    { ...options, penUpHeight: 101 },
    { ...options, penDownMaxVelocity: 0 },
    { ...options, penDropDuration: Infinity },
    { ...options, paperSize: { size: { x: 0, y: 297 } } },
    { ...options, hardware: "unknown" },
    { ...options, marginMm: 10000 },
    {},
    null,
  ])
    expect(() => validatePresetOptions(invalid)).toThrow();
  expect(validatePresetName("  Brush / A3  ")).toBe("Brush / A3");
  for (const name of ["", " ", "x".repeat(81), "bad\nname"]) expect(() => validatePresetName(name)).toThrow();
});
