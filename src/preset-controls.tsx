import React, { useState } from "react";
import type { PlanOptions } from "./planning.js";
import { type Preset, type PresetOptions, presetOptions } from "./preset-options.js";

async function requestPresets(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `Preset request failed (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
}

export function PresetControls({
  options,
  disabled,
  onLoad,
}: {
  options: PlanOptions;
  disabled: boolean;
  onLoad: (options: PresetOptions) => void;
}): React.JSX.Element {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  React.useEffect(() => {
    const controller = new AbortController();
    requestPresets("/presets", { signal: controller.signal })
      .then(setPresets)
      .catch((reason: Error) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    return () => controller.abort();
  }, []);

  async function refresh() {
    setBusy(true);
    setError("");
    try {
      setPresets(await requestPresets("/presets"));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const preset: Preset = await requestPresets(`/presets/${encodeURIComponent(name.trim())}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(presetOptions(options)),
      });
      setPresets(await requestPresets("/presets"));
      setSelected(preset.name);
      setName(preset.name);
      setMessage(`Saved “${preset.name}” on the Pi.`);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete preset “${selected}”?`)) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await requestPresets(`/presets/${encodeURIComponent(selected)}`, { method: "DELETE" });
      setPresets(await requestPresets("/presets"));
      setSelected("");
      setName("");
      setMessage("Preset deleted.");
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function load() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const preset: Preset = await requestPresets(`/presets/${encodeURIComponent(selected)}/load`, { method: "POST" });
      onLoad(preset.options);
      setMessage(`Loaded “${preset.name}”.`);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const preset = presets.find((item) => item.name === selected);
  return (
    <div className="preset-controls">
      <label htmlFor="shared-preset">Saved setup</label>
      <select
        id="shared-preset"
        value={selected}
        disabled={busy || disabled}
        onChange={(event) => {
          setSelected(event.target.value);
          setName(event.target.value);
          setMessage("");
        }}
      >
        <option value="">Choose a preset…</option>
        {presets.map((item) => (
          <option key={item.name} value={item.name}>
            {item.name}
          </option>
        ))}
      </select>
      <div className="button-row">
        <button type="button" disabled={!preset || busy || disabled} onClick={() => void load()}>
          Load
        </button>
        <button type="button" disabled={busy} onClick={() => void refresh()}>
          Refresh
        </button>
        <button type="button" disabled={!preset || busy} onClick={() => void remove()}>
          Delete
        </button>
      </div>
      <label htmlFor="preset-name">Preset name</label>
      <input
        id="preset-name"
        type="text"
        maxLength={80}
        placeholder="e.g. Brush pen · A3"
        value={name}
        disabled={busy || disabled}
        onChange={(event) => setName(event.target.value)}
      />
      <button type="button" disabled={!name.trim() || busy || disabled} onClick={() => void save()}>
        {presets.some((item) => item.name === name.trim()) ? "Update preset" : "Save current setup"}
      </button>
      <p className="settings-note">Pen, paper and motion settings, shared across computers.</p>
      {message && (
        <p role="status" className="settings-note">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="settings-error">
          {error}
        </p>
      )}
    </div>
  );
}
