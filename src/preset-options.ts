import type { Hardware } from "./ebb.js";
import { defaultPlanOptions, type PlanOptions } from "./planning.js";

export type PresetOptions = Omit<
  PlanOptions,
  "selectedStrokeLayers" | "selectedGroupLayers" | "layerMode" | "penHome" | "paperSize"
> & { paperSize: { size: { x: number; y: number } } };

export interface Preset {
  name: string;
  options: PresetOptions;
}

export function presetOptions(options: PlanOptions): PresetOptions {
  const { selectedStrokeLayers, selectedGroupLayers, layerMode, penHome, paperSize, ...settings } = options;
  return { ...settings, paperSize: { size: { ...paperSize.size } } };
}

export function validatePresetOptions(value: unknown): PresetOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid preset settings");
  const input = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, expected] of Object.entries(presetOptions(defaultPlanOptions))) {
    const item = input[key];
    if (key === "paperSize") {
      const size = (item as PresetOptions["paperSize"] | undefined)?.size;
      if (!size || ![size.x, size.y].every((n) => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 10000)) {
        throw new Error("Paper dimensions must be positive millimetres");
      }
      result[key] = { size: { x: size.x, y: size.y } };
    } else if (key === "hardware") {
      if (!["v3", "brushless", "nextdraw-2234", "idraw-h-se"].includes(item as Hardware)) throw new Error("Invalid hardware model");
      result[key] = item;
    } else if (typeof expected === "number") {
      if (typeof item !== "number" || !Number.isFinite(item) || (key !== "rotateDrawing" && item < 0)) {
        throw new Error(`Invalid ${key}`);
      }
      if ((key === "penUpHeight" || key === "penDownHeight") && item > 100)
        throw new Error("Pen heights must be 0–100%");
      if (/(Acceleration|Velocity|CorneringFactor)$/.test(key) && item <= 0) throw new Error(`${key} must be positive`);
      result[key] = item;
    } else {
      if (typeof item !== "boolean") throw new Error(`Invalid ${key}`);
      result[key] = item;
    }
  }
  const options = result as PresetOptions;
  if (options.marginMm * 2 >= Math.min(options.paperSize.size.x, options.paperSize.size.y)) {
    throw new Error("Margins must leave space on the paper");
  }
  return options;
}
