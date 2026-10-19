import { afterEach, describe, expect, it, vi } from "vitest";
import { EBB } from "../ebb.js";
import { WebSerialDriver } from "../drivers.js";
import { AxidrawBrushlessFast, Plan, plan } from "../planning.js";

const drawing = () =>
  plan(
    [
      [
        { x: 10, y: 10 },
        { x: 20, y: 10 },
      ],
    ],
    AxidrawBrushlessFast,
  );

function transport() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const commands: string[] = [];
  const encoder = new TextEncoder();
  const reply = (line: string) => controller.enqueue(encoder.encode(`${line}\r\n`));
  const state = { respond: (command: string): string | null => (command === "QM" ? "QM,0,0,0,0" : "OK") };
  const port = {
    readable: new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(bytes) {
        const command = new TextDecoder().decode(bytes).trim();
        commands.push(command);
        const response = command === "V" ? "test 2.5.3" : state.respond(command);
        if (response !== null) reply(response);
      },
    }),
    open: async () => {},
    close: vi.fn(async () => {}),
    getInfo: () => ({ usbVendorId: 0x04d8, usbProductId: 0xfd92 }),
  };
  return {
    port,
    commands,
    state,
    reply,
    end: () => controller.close(),
    fail: () => controller.error(new Error("Disconnected")),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("serial failures", () => {
  it.each(["end", "fail"] as const)("rejects pending and later commands on stream %s", async (action) => {
    const t = transport();
    const ebb = await EBB.create(t.port);
    t.state.respond = () => null;
    const command = ebb.command("EM,1,1");
    const rejected = expect(command).rejects.toThrow(/closed|Disconnected/);
    t[action]();
    await rejected;
    await expect(ebb.command("EM,0,0")).rejects.toThrow(/closed|Disconnected/);
  });

  it("rejects write failures without leaving a pending command", async () => {
    const t = transport();
    const ebb = await EBB.create(t.port);
    t.state.respond = () => {
      throw new Error("Write failed");
    };
    await expect(ebb.command("EM,1,1")).rejects.toThrow("Write failed");
  });

  it("bounds a missing response and prevents reuse of a desynchronized transport", async () => {
    const t = transport();
    const ebb = await EBB.create(t.port);
    t.state.respond = () => null;
    vi.useFakeTimers();
    const rejected = expect(ebb.command("EM,1,1")).rejects.toThrow("Timed out");
    await vi.advanceTimersByTimeAsync(30001);
    await rejected;
    await expect(ebb.query("QM")).rejects.toThrow("Timed out");
  });

  it("releases serial stream locks before closing the port", async () => {
    const t = transport();
    const ebb = await EBB.create(t.port);
    t.port.close.mockImplementation(async () => {
      expect(t.port.readable.locked).toBe(false);
      expect(t.port.writable.locked).toBe(false);
    });
    await ebb.close();
    expect(t.port.close).toHaveBeenCalledOnce();
  });
});

describe("shared plot lifecycle", () => {
  it("raises the pen before travel and waits for idle before completing", async () => {
    const t = transport();
    const ebb = await EBB.create(t.port);
    t.state.respond = (cmd) => (cmd === "QM" ? null : "OK");
    let complete = false;
    const running = ebb.executePlan(drawing()).then(() => {
      complete = true;
    });
    await vi.waitFor(() => expect(t.commands).toContain("QM"));
    expect(t.commands.findIndex((c) => c.startsWith("S2,"))).toBeLessThan(
      t.commands.findIndex((c) => c.startsWith("LM,")),
    );
    expect(complete).toBe(false);
    expect(t.commands).not.toContain("EM,0,0");
    t.reply("QM,0,0,0,0");
    await running;
    expect(t.commands.at(-1)).toBe("EM,0,0");
  });

  it("still disables motors and preserves the original error when motion fails", async () => {
    const t = transport();
    const ebb = await EBB.create(t.port);
    t.state.respond = (cmd) => (cmd.startsWith("LM,") ? "!1 motion failed" : cmd === "QM" ? "QM,0,0,0,0" : "OK");
    await expect(ebb.executePlan(drawing())).rejects.toThrow("motion failed");
    expect(t.commands.at(-1)).toBe("EM,0,0");
    const failedAt = t.commands.findIndex((c) => c.startsWith("LM,"));
    expect(t.commands.slice(failedAt + 1).some((c) => c.startsWith("S2,"))).toBe(true);
  });

  it("cancels during setup without an unhandled rejection and cleans up", async () => {
    const t = transport();
    const ebb = await EBB.create(t.port);
    t.state.respond = (cmd) => (cmd === "EM,1,1" ? null : cmd === "QM" ? "QM,0,0,0,0" : "OK");
    const controller = new AbortController();
    const running = ebb.executePlan(drawing(), 1, { signal: controller.signal });
    await vi.waitFor(() => expect(t.commands).toContain("EM,1,1"));
    controller.abort();
    t.reply("OK");
    await expect(running).resolves.toBe("cancelled");
    expect(t.commands.at(-1)).toBe("EM,0,0");
    expect(t.commands.some((c) => c.startsWith("LM,"))).toBe(false);
  });

  it("can still cancel while waiting for buffered motion to finish", async () => {
    const t = transport();
    const ebb = await EBB.create(t.port);
    t.state.respond = (cmd) => (cmd === "QM" ? null : "OK");
    const controller = new AbortController();
    const running = ebb.executePlan(drawing(), 1, { signal: controller.signal });
    await vi.waitFor(() => expect(t.commands).toContain("QM"));
    t.state.respond = (cmd) => (cmd === "QM" ? "QM,0,0,0,0" : "OK");
    controller.abort();
    t.reply("QM,0,0,0,0");
    await expect(running).resolves.toBe("cancelled");
    expect(t.commands).toContain("HM,4000");
    expect(t.commands.at(-1)).toBe("EM,0,0");
  });

  it("treats an empty drawing as a hardware-free no-op", async () => {
    const t = transport();
    const ebb = await EBB.create(t.port);
    await ebb.executePlan(new Plan([]));
    await ebb.executePlan(plan([], AxidrawBrushlessFast));
    expect(t.commands).toEqual(["V"]);
  });

  it("cancels a paused WebSerial plot and announces completion only after cleanup", async () => {
    const t = transport();
    vi.stubGlobal("navigator", { serial: { addEventListener: vi.fn(), removeEventListener: vi.fn() } });
    const driver = await WebSerialDriver.connect(t.port as unknown as SerialPort);
    const paused = vi.fn();
    const cancelled = vi.fn(() => expect(t.commands.at(-1)).toBe("EM,0,0"));
    driver.onpause = paused;
    driver.oncancelled = cancelled;
    driver.onprogress = (index) => {
      if (index === 0) driver.pause();
    };
    const running = driver.plot(drawing());
    await vi.waitFor(() => expect(paused).toHaveBeenCalledWith(true));
    driver.cancel();
    await running;
    expect(cancelled).toHaveBeenCalledOnce();
    expect(paused).toHaveBeenLastCalledWith(false);
  });

  it("reports WebSerial plot failures after cleanup and handles manual command failures", async () => {
    const t = transport();
    vi.stubGlobal("navigator", { serial: { addEventListener: vi.fn(), removeEventListener: vi.fn() } });
    const driver = await WebSerialDriver.connect(t.port as unknown as SerialPort);
    const error = vi.fn();
    driver.onerror = error;
    t.state.respond = (cmd) => (cmd.startsWith("LM,") ? "!1 motion failed" : cmd === "QM" ? "QM,0,0,0,0" : "OK");
    await driver.plot(drawing());
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining("motion failed"), true);
    expect(t.commands.at(-1)).toBe("EM,0,0");
    t.state.respond = () => "!1 servo failed";
    await driver.setPenHeight(9000, 1000);
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining("servo failed"));
  });
});
