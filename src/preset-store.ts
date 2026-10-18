import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Preset, validatePresetOptions } from "./preset-options.js";

export class PresetStore {
  private pending: Promise<void> = Promise.resolve();

  constructor(private filename: string) {}

  async list(): Promise<Preset[]> {
    await this.pending;
    return this.read();
  }

  private async read(): Promise<Preset[]> {
    try {
      const data: unknown = JSON.parse(await readFile(this.filename, "utf8"));
      if (!Array.isArray(data)) throw new Error("Invalid presets file");
      return data.map((entry) => ({
        name: validatePresetName(entry.name),
        options: validatePresetOptions(entry.options),
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  update(name: string, options: Preset["options"] | null): Promise<void> {
    const task = this.pending.then(async () => {
      const presets = (await this.read()).filter((preset) => preset.name !== name);
      if (options) presets.push({ name, options });
      presets.sort((a, b) => a.name.localeCompare(b.name));
      await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      // Rename only after the full file is written; readers never see partial settings.
      await writeFile(`${this.filename}.tmp`, `${JSON.stringify(presets, null, 2)}\n`, { mode: 0o600 });
      await rename(`${this.filename}.tmp`, this.filename);
    });
    this.pending = task.catch(() => {});
    return task;
  }
}

export function validatePresetName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80 || /\p{Cc}/u.test(value)) {
    throw new Error("Use a preset name of 1–80 characters");
  }
  return value.trim();
}
