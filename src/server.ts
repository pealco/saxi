/**
 * Backend web server for controlling the EBB.
 * Serve both the front end UI as static files - made with React, and backend
 * API for controlling the EBB.
 * Keep open web sockets to the front end for real-time updates.
 */

import http from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { autoDetect } from "@serialport/bindings-cpp";
import type { PortInfo } from "@serialport/bindings-interface";
import cors from "cors";
import type { Request, Response } from "express";
import express from "express";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { createMockSerialPort } from "./__tests__/mocks/serialport.js";
import { EBB, type EBBPort, type Hardware } from "./ebb.js";
import { type Motion, PenMotion, Plan } from "./planning.js";
import { validatePresetOptions } from "./preset-options.js";
import { PresetStore, validatePresetName } from "./preset-store.js";
import { SerialPortSerialPort } from "./serialport-serialport.js";
import * as _self from "./server.js"; // use self-import for test mocking
import { formatDuration } from "./util.js";

type Com = string;

/**
 * Shorthand for getting the device info, either EBB or com port.
 * @param ebb
 * @param com
 * @returns
 */
const getDeviceInfo = (ebb: EBB | null, _com: Com, fallbackHardware: Hardware = "brushless") => {
  // biome-ignore lint/suspicious/noExplicitAny: private member access
  const portPath = (ebb?.port as any)?._path ?? null;
  return { path: portPath, hardware: ebb?.hardware ?? fallbackHardware };
};

/**
 * Start the express server.
 * @param port
 * @param hardware
 * @param com
 * @param enableCors
 * @param maxPayloadSize
 * @returns
 */
export async function startServer(
  port: number,
  hardware: Hardware = "brushless",
  com: Com = "",
  enableCors = false,
  maxPayloadSize = "200mb",
  dataDirectory = process.env.SAXI_DATA_DIR ?? path.join(homedir(), ".local", "share", "saxi"),
) {
  const app = express();
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  app.use("/", express.static(path.join(__dirname, "..", "ui")));
  app.use("/presets", express.json({ limit: "32kb" }));
  app.use(express.json({ limit: maxPayloadSize }));
  if (enableCors) {
    app.use(cors());
  }
  // Web and Socket server
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  let ebb: EBB | null = null;
  let currentHardware: Hardware = hardware;
  let clients: WebSocket[] = [];
  let unpaused: Promise<void> | null = null;
  let signalUnpause: (() => void) | null = null;
  let motionIdx: number | null = null;
  let currentPlan: Plan | null = null;
  let plotting = false;
  let controller: AbortController | null = null;
  let updateLeaseUntil = 0;
  const maintenanceFile = path.join(dataDirectory, "maintenance-until");
  try {
    updateLeaseUntil = Number(await readFile(maintenanceFile, "utf8"));
    if (!Number.isFinite(updateLeaseUntil)) throw new Error("Invalid update reservation");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const presets = new PresetStore(path.join(dataDirectory, "presets.json"));

  app.get("/presets", async (_req, res) => {
    res.set("Cache-Control", "no-store").json(await presets.list());
  });

  app.use(["/presets", "/maintenance"], (req, res, next) => {
    if (req.method === "GET") return next();
    const origin = req.get("origin");
    if (origin && origin !== `${req.protocol}://${req.get("host")}`) {
      res.status(403).json({ error: "Use Saxi from its own address" });
      return;
    }
    next();
  });

  app.put("/presets/:name", async (req, res) => {
    let name: string;
    let options: ReturnType<typeof validatePresetOptions>;
    try {
      name = validatePresetName(req.params.name);
      options = validatePresetOptions(req.body);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
      return;
    }
    await presets.update(name, options);
    res.json({ name, options });
  });

  app.delete("/presets/:name", async (req, res) => {
    let name: string;
    try {
      name = validatePresetName(req.params.name);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
      return;
    }
    await presets.update(name, null);
    res.status(204).end();
  });

  app.post("/presets/:name/load", async (req, res) => {
    const preset = (await presets.list()).find((item) => item.name === req.params.name);
    if (!preset) {
      res.status(404).json({ error: "Preset no longer exists. Refresh the list." });
      return;
    }
    if (plotting || updateLeaseUntil > Date.now()) {
      res.status(409).json({ error: "Wait until the plot or update finishes before loading a preset." });
      return;
    }
    if (currentHardware !== preset.options.hardware) {
      currentHardware = preset.options.hardware;
      ebb?.changeHardware(currentHardware);
      broadcast({ c: "dev", p: getDeviceInfo(ebb, com, currentHardware) });
    }
    res.json(preset);
  });

  // Reserve an idle service before deployment so a new plot cannot race an update.
  app.post("/maintenance", async (req, res) => {
    if (plotting || updateLeaseUntil > Date.now()) {
      res.status(409).json({ error: plotting ? "A plot is in progress" : "An update is already in progress" });
      return;
    }
    if (req.body?.updating !== true) {
      res.status(400).json({ error: "Expected updating: true" });
      return;
    }
    updateLeaseUntil = Date.now() + 5 * 60 * 1000;
    try {
      await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
      await writeFile(`${maintenanceFile}.tmp`, String(updateLeaseUntil), { mode: 0o600 });
      await rename(`${maintenanceFile}.tmp`, maintenanceFile);
    } catch (error) {
      updateLeaseUntil = 0;
      throw error;
    }
    res.json({ updating: true });
  });

  app.delete("/maintenance", async (_req, res) => {
    await rm(maintenanceFile, { force: true });
    updateLeaseUntil = 0;
    res.status(204).end();
  });

  wss.on("connection", (ws) => {
    clients.push(ws);
    ws.on("message", async (message) => {
      const msg = JSON.parse(message.toString());
      switch (msg.c) {
        case "ping":
          ws.send(JSON.stringify({ c: "pong" }));
          break;
        case "limp":
          await ebb?.disableMotors();
          break;
        case "setPenHeight":
          if (!ebb) break;
          if (ebb.supportsSR()) {
            await ebb.setServoPowerTimeout(10000, true);
          }
          await ebb.setPenHeight(msg.p.height, msg.p.rate);
          break;
        case "changeHardware":
          currentHardware = msg.p.hardware;
          ebb?.changeHardware(currentHardware);
          broadcast({ c: "dev", p: getDeviceInfo(ebb, com, currentHardware) });
          break;
      }
    });

    // send starting params to clients
    ws.send(JSON.stringify({ c: "dev", p: getDeviceInfo(ebb, com, currentHardware) }));

    ws.send(JSON.stringify({ c: "pause", p: { paused: !!unpaused } }));
    if (motionIdx !== null) {
      ws.send(JSON.stringify({ c: "progress", p: { motionIdx } }));
    }
    if (currentPlan !== null) {
      ws.send(JSON.stringify({ c: "plan", p: { motions: currentPlan.toTransferable() } }));
    }

    ws.on("close", () => {
      clients = clients.filter((w) => w !== ws);
    });
  });

  /**
   * /plot POST endpoint. Receive a plan on the POST body, and execute it.
   */
  app.post("/plot", async (req: Request, res: Response) => {
    if (updateLeaseUntil > Date.now()) {
      res.status(503).send("Saxi is being updated. Try again shortly.");
      return;
    }
    if (plotting) {
      console.log("Received plot request, but a plot is already in progress!");
      res.status(400).send("Plot in progress");
      return;
    }
    plotting = true;
    controller = new AbortController();
    const { signal } = controller;
    try {
      const plan = Plan.deserialize(req.body);
      currentPlan = plan;
      console.log(`Received plan of estimated duration ${formatDuration(plan.duration())}`);
      console.log(ebb !== null ? "Beginning plot..." : "Simulating plot...");
      res.status(200).end();

      const begin = Date.now();
      let wakeLock: { release(): void } | null = null;

      // The wake-lock module is macOS-only.
      if (process.platform === "darwin") {
        try {
          // Dynamically import wake-lock only on macOS
          const { WakeLock } = await import("wake-lock");
          wakeLock = new WakeLock("saxi plotting");
        } catch (_error) {
          console.warn("Couldn't acquire wake lock. Ensure your machine does not sleep during plotting");
        }
      } else {
        console.log("Wake lock not available on this platform. Ensure your machine does not sleep during plotting");
      }
      try {
        const plotEbb = ebb ?? (await EBB.create(createMockSerialPort() as unknown as EBBPort, currentHardware));
        await doPlot(createPlotter(plotEbb), plan, signal);
        const end = Date.now();
        console.log(`Plot took ${formatDuration((end - begin) / 1000)}`);
      } finally {
        if (wakeLock) {
          wakeLock.release();
        }
      }
    } finally {
      plotting = false;
      controller = null;
    }
  });

  app.get("/plot/status", (_req, res) => {
    res.json({ plotting });
  });

  app.post("/cancel", (_req: Request, res: Response) => {
    if (controller) {
      controller.abort();
      controller = null;
    }
    ebb?.cancel();
    if (unpaused) {
      signalUnpause?.();
      broadcast({ c: "pause", p: { paused: false } });
    }
    unpaused = signalUnpause = null;
    res.status(200).end();
  });

  app.post("/pause", (_req: Request, res: Response) => {
    if (!unpaused) {
      unpaused = new Promise((resolve) => {
        signalUnpause = resolve;
      });
      broadcast({ c: "pause", p: { paused: true } });
    }
    res.status(200).end();
  });

  app.post("/resume", (_req: Request, res: Response) => {
    if (signalUnpause) {
      signalUnpause();
      signalUnpause = unpaused = null;
    }
    res.status(200).end();
  });

  function broadcast(msg: Record<string, unknown>) {
    for (const client of clients) {
      try {
        client.send(JSON.stringify(msg));
      } catch (e) {
        console.warn(e);
      }
    }
  }

  interface Plotter {
    prePlot: (initialPenHeight: number) => Promise<void>;
    executeMotion: (m: Motion, progress: [number, number]) => Promise<void>;
    postCancel: (initialPenHeight: number) => Promise<void>;
    postPlot: () => Promise<void>;
  }

  function createPlotter(ebb: EBB): Plotter {
    return {
      async prePlot(initialPenHeight: number): Promise<void> {
        await ebb.configureFifoDepth();
        await ebb.enableMotors(1); // 16x microstepping, matches defaults from Axidraw
        await ebb.setPenHeight(initialPenHeight, 1000, 1000);
      },
      async executeMotion(motion: Motion, _progress: [number, number]): Promise<void> {
        await ebb.executeMotion(motion);
      },
      async postCancel(initialPenHeight: number): Promise<void> {
        await ebb.setPenHeight(initialPenHeight, 1000);
        await ebb.command("HM,4000"); // HM returns carriage home without 3rd and 4th arguments
        await ebb.waitUntilMotorsIdle();
      },
      async postPlot(): Promise<void> {
        await ebb.waitUntilMotorsIdle();
        await ebb.disableMotors();
      },
    };
  }

  async function doPlot(plotter: Plotter, plan: Plan, signal: AbortSignal): Promise<void> {
    const abortPromise = onceAbort(signal); // reuse abort promise
    unpaused = null;
    signalUnpause = null;
    motionIdx = 0;

    const firstPenMotion = plan.motions.find((x) => x instanceof PenMotion) as PenMotion;
    await plotter.prePlot(firstPenMotion.initialPos);

    let penIsUp = true;
    try {
      for (const motion of plan.motions) {
        broadcast({ c: "progress", p: { motionIdx } });

        await Promise.race([plotter.executeMotion(motion, [motionIdx, plan.motions.length]), abortPromise]);

        if (motion instanceof PenMotion) {
          penIsUp = motion.initialPos < motion.finalPos;
        }

        if (unpaused && penIsUp) {
          await Promise.race([unpaused, abortPromise]);
          broadcast({ c: "pause", p: { paused: false } });
        }

        motionIdx += 1;
      }

      broadcast({ c: "finished" });
    } catch (err) {
      if (signal.aborted) {
        await plotter.postCancel(firstPenMotion.initialPos);
        broadcast({ c: "cancelled" });
        return;
      }
      throw err; // propagate real errors
    } finally {
      motionIdx = null;
      currentPlan = null;
      await plotter.postPlot();
    }
  }

  function onceAbort(signal: AbortSignal): Promise<never> {
    return new Promise((_resolve, reject) => {
      signal.throwIfAborted();
      signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    });
  }

  return new Promise<http.Server>((resolve) => {
    server.listen(port, () => {
      async function connect() {
        const devices = ebbs(com, currentHardware);
        for await (const device of devices) {
          device?.changeHardware(currentHardware);
          ebb = device;
          broadcast({ c: "dev", p: getDeviceInfo(ebb, com, currentHardware) });
        }
      }
      connect();
      const { family, address, port } = server.address() as AddressInfo;
      const addr = `${family === "IPv6" ? `[${address}]` : address}:${port}`;
      console.log(`Server listening on http://${addr}`);
      resolve(server);
    });
  });
}

async function tryOpen(com: Com) {
  const port = new SerialPortSerialPort(com);
  await port.open({ baudRate: 9600 });
  if (!port.readable || !port.writable) {
    throw new Error("Serial port opened but readable/writable streams are unavailable");
  }
  return port;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEBB(p: PortInfo): boolean {
  return (
    p.manufacturer === "SchmalzHaus" ||
    p.manufacturer === "SchmalzHaus LLC" ||
    (p.vendorId === "04D8" && p.productId === "FD92")
  );
}

async function listEBBs() {
  const Binding = autoDetect();
  const ports = await Binding.list();
  return ports.filter(isEBB).map((p: { path: string }) => p.path);
}

export async function waitForEbb(): Promise<Com> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ebbs = await listEBBs();
    if (ebbs.length) {
      return ebbs[0];
    }
    await sleep(5000);
  }
}

async function* ebbs(path?: string, hardware: Hardware = "brushless") {
  while (true) {
    try {
      const com: Com = path || (await _self.waitForEbb()); // use self-import for test mocking
      console.log(`Found EBB at ${com}`);
      const port = await tryOpen(com);
      try {
        const closed = new Promise((resolve) => {
          port.addEventListener("disconnect", resolve, { once: true });
        });
        yield await EBB.create(port, hardware);
        await closed;
        yield null;
        console.error("Lost connection to EBB, reconnecting...");
      } finally {
        if (port.connected) {
          await port.close();
        }
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.error(`Error connecting to EBB: ${err.message}`);
      console.error("Retrying in 5 seconds...");
      await sleep(5000);
    }
  }
}

export async function connectEBB(hardware: Hardware, device?: string): Promise<EBB | null> {
  const dev = device ?? (await listEBBs())[0];
  if (!dev) return null;

  const port = await tryOpen(dev);
  return await EBB.create(port, hardware);
}
