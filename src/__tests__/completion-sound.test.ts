import { expect, test, vi } from "vitest";
import { playCompletionSound } from "../completion-sound.js";

test("schedule a short audible chime with a quiet envelope and release the audio nodes", () => {
  const oscillators: any[] = [];
  const gains: any[] = [];
  const context = {
    currentTime: 10,
    destination: {},
    createOscillator: () => {
      const oscillator = {
        frequency: { value: 0 },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn(),
        onended: () => {},
      };
      oscillators.push(oscillator);
      return oscillator;
    },
    createGain: () => {
      const gain = {
        gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      gains.push(gain);
      return gain;
    },
  };
  playCompletionSound(context as unknown as AudioContext);
  expect(oscillators.length).toBeGreaterThan(0);
  for (const [index, oscillator] of oscillators.entries()) {
    expect(oscillator.frequency.value).toBeGreaterThan(20);
    expect(oscillator.frequency.value).toBeLessThan(20000);
    const start = oscillator.start.mock.calls[0][0];
    const stop = oscillator.stop.mock.calls[0][0];
    expect(start).toBeGreaterThanOrEqual(context.currentTime);
    expect(stop).toBeGreaterThan(start);
    expect(stop).toBeLessThan(context.currentTime + 1);
    expect(gains[index].gain.setValueAtTime).toHaveBeenCalledWith(0, start);
    oscillator.onended();
    expect(oscillator.disconnect).toHaveBeenCalledOnce();
    expect(gains[index].disconnect).toHaveBeenCalledOnce();
  }
});
