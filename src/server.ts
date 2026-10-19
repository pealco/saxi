/**
 * Backend web server for controlling the EBB.
 * Serve both the front end UI as static files - made with React, and backend
 * API for controlling the EBB.
 * Keep open web sockets to the front end for real-time updates.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { autoDetect } from "@serialport/bindings-cpp";
import type { PortInfo } from "@serialport/bindings-interface";
import cors from "cors";
import type { Request, Response } from "express";
import express from "express";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { EBB, type Hardware } from "./ebb.js";
import { Device, PenMotion, Plan } from "./planning.js";
import { createSimulatedSerialPort } from "./simulated-serial.js";
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
) {
  const app = express();
  function isAllowedOrigin(req: http.IncomingMessage): boolean {
    const { host, origin } = req.headers;
    return !!host && (!origin || enableCors || origin === `http://${host}`);
  }
  if (enableCors) app.use(cors());
  app.use((req, res, next) => {
    if (isAllowedOrigin(req)) return next();
    res.status(403).send("Origin or host not allowed");
  });
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  app.use("/", express.static(path.join(__dirname, "..", "ui")));
  app.use(express.json({ limit: maxPayloadSize }));
  // Web and Socket server
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (!isAllowedOrigin(req)) {
      socket.end("HTTP/1.1 403 Rejected\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  let ebb: EBB | null = null;
  let currentHardware: Hardware = hardware;
  let clients: WebSocket[] = [];
  let unpaused: Promise<void> | null = null;
  let signalUnpause: (() => void) | null = null;
  let motionIdx: number | null = null;
  let currentPlan: Plan | null = null;
  let plotting = false;
  let controller: AbortController | null = null;

  wss.on("connection", (ws) => {
    clients.push(ws);
    ws.on("error", (error) => console.warn("WebSocket error", error.message));
    ws.on("message", async (message) => {
      try {
        const msg = JSON.parse(message.toString());
        if (!msg || typeof msg !== "object" || typeof msg.c !== "string") throw new Error("Invalid control message");
        if (plotting && msg.c !== "ping") throw new Error("Manual controls are unavailable during a plot");
        switch (msg.c) {
          case "ping":
            ws.send(JSON.stringify({ c: "pong" }));
            break;
          case "limp":
            await ebb?.disableMotors();
            break;
          case "setPenHeight":
            if (
              !msg.p ||
              !Number.isFinite(msg.p.height) ||
              !Number.isFinite(msg.p.rate) ||
              msg.p.height < Device(currentHardware).penServoMin ||
              msg.p.height > Device(currentHardware).penServoMax ||
              msg.p.rate <= 0 ||
              msg.p.rate > 65535
            )
              throw new Error("Invalid pen height or rate");
            if (!ebb) break;
            if (ebb.supportsSR()) {
              await ebb.setServoPowerTimeout(10000, true);
            }
            await ebb.setPenHeight(msg.p.height, msg.p.rate);
            break;
          case "changeHardware":
            if (!["v3", "brushless", "nextdraw-2234", "idraw-h-se"].includes(msg.p?.hardware))
              throw new Error("Invalid hardware");
            currentHardware = msg.p.hardware;
            ebb?.changeHardware(currentHardware);
            broadcast({ c: "dev", p: getDeviceInfo(ebb, com, currentHardware) });
            break;
          default:
            throw new Error("Unknown control command");
        }
      } catch (error) {
        ws.send(JSON.stringify({ c: "error", p: { message: error instanceof Error ? error.message : String(error) } }));
      }
    });

    // send starting params to clients
    ws.send(JSON.stringify({ c: "dev", p: getDeviceInfo(ebb, com, currentHardware) }));

    ws.send(JSON.stringify({ c: "pause", p: { paused: !!unpaused } }));
    if (motionIdx !== null) {
      ws.send(JSON.stringify({ c: "progress", p: { motionIdx } }));
    }
    if (currentPlan !== null) {
      ws.send(JSON.stringify({ c: "plan", p: { motions: currentPlan.serialize() } }));
    }

    ws.on("close", () => {
      clients = clients.filter((w) => w !== ws);
    });
  });

  /**
   * /plot POST endpoint. Receive a plan on the POST body, and execute it.
   */
  app.post("/plot", async (req: Request, res: Response) => {
    if (plotting) {
      console.log("Received plot request, but a plot is already in progress!");
      res.status(400).send("Plot in progress");
      return;
    }
    let plan: Plan;
    try {
      plan = Plan.deserialize(req.body);
      const device = Device(currentHardware);
      for (const motion of plan.motions) {
        if (
          motion instanceof PenMotion &&
          [motion.initialPos, motion.finalPos].some(
            (position) => position < device.penServoMin || position > device.penServoMax,
          )
        )
          throw new Error("Pen position outside the selected hardware's range");
      }
    } catch (error) {
      res.status(400).send(error instanceof Error ? error.message : String(error));
      return;
    }
    plotting = true;
    unpaused = signalUnpause = null;
    controller = new AbortController();
    const { signal } = controller;
    let outcome = "finished";
    try {
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
        const simulated = ebb === null;
        const plotEbb = ebb ?? (await EBB.create(createSimulatedSerialPort(), currentHardware));
        try {
          outcome = await plotEbb.executePlan(plan, 1, {
            signal,
            onprogress(index) {
              motionIdx = index;
              broadcast({ c: "progress", p: { motionIdx } });
            },
            waitWhilePaused: () => unpaused,
          });
        } finally {
          if (simulated) await plotEbb.close();
        }
        const end = Date.now();
        console.log(`Plot took ${formatDuration((end - begin) / 1000)}`);
      } finally {
        if (wakeLock) {
          wakeLock.release();
        }
      }
    } catch (error) {
      outcome = "error";
      console.error("Plot failed", error);
    } finally {
      plotting = false;
      controller = null;
      motionIdx = null;
      currentPlan = null;
      resume();
      broadcast({
        c: outcome,
        p: {
          message: outcome === "error" ? "Plot failed. Check the device connection and server log." : undefined,
          plotFailed: outcome === "error",
        },
      });
    }
  });

  app.get("/plot/status", (_req, res) => {
    res.json({ plotting });
  });

  app.post("/cancel", (_req: Request, res: Response) => {
    if (controller) {
      controller.abort();
    }
    resume();
    res.status(200).end();
  });

  app.post("/pause", (_req: Request, res: Response) => {
    if (plotting && !unpaused) {
      unpaused = new Promise((resolve) => {
        signalUnpause = resolve;
      });
      broadcast({ c: "pause", p: { paused: true } });
    }
    res.status(200).end();
  });

  app.post("/resume", (_req: Request, res: Response) => {
    resume();
    res.status(200).end();
  });

  function resume() {
    signalUnpause?.();
    signalUnpause = unpaused = null;
    broadcast({ c: "pause", p: { paused: false } });
  }

  function broadcast(msg: Record<string, unknown>) {
    for (const client of clients) {
      try {
        client.send(JSON.stringify(msg));
      } catch (e) {
        console.warn(e);
      }
    }
  }

  return new Promise<http.Server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      async function connect() {
        const devices = ebbs(com, currentHardware);
        for await (const device of devices) {
          device?.changeHardware(currentHardware);
          ebb = device;
          broadcast({ c: "dev", p: getDeviceInfo(ebb, com, currentHardware) });
        }
      }
      void connect().catch((error: unknown) => console.error("Device connection failed", error));
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
