import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { AxidrawFast, plan } from "../planning.js";
import { defaultPlanOptions } from "../planning.js";
import { presetOptions } from "../preset-options.js";
import { createMockSerialPort, mockSerialPortInstance } from "./mocks/serialport.js";

// Mock SerialPortSerialPort using shared implementation
vi.mock("../serialport-serialport", () => ({
  SerialPortSerialPort: vi.fn(function SerialPortSerialPort() {
    return createMockSerialPort();
  }),
}));

// Mock server to use test device
vi.mock("../server", async () => {
  const original = (await vi.importActual("../server")) as any;
  return {
    ...original,
    startServer: (port: number, hardware?: string, ...args: any[]) =>
      original.startServer(port, hardware, "/dev/ttyMOCK", ...args.slice(1)),
    waitForEbb: vi.fn().mockResolvedValue("/dev/ttyMOCK"),
  };
});

import { startServer } from "../server.js";

const SIMPLE_PATHS = [
  [{x: 10, y: 10}, {x: 20, y: 10}],
]; // biome-ignore format: compactness

const COMPLEX_PATHS = [
  [{x: 0, y: 0}, {x: 100, y: 0}],
  [{x: 0, y: 50}, {x: 100, y: 50}],
  [{x: 0, y: 100}, {x: 100, y: 100}],
  [{x: 0, y: 150}, {x: 100, y: 150}],
]; // biome-ignore format: compactness

// Pre-serialized plan constants
const SIMPLE_PLAN = plan(SIMPLE_PATHS, AxidrawFast).serialize();
const COMPLEX_PLAN = plan(COMPLEX_PATHS, AxidrawFast).serialize();

// Helper function to wait for plotting to complete
async function waitForPlottingComplete(server: Server, timeout = 10000): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const response = await request(server).get("/plot/status");
    if (!response.body.plotting) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForCommandsLogged(command = "EM,1,1", timeout = 5000): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (mockSerialPortInstance.commands.includes(command)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Plot Endpoint Test Suite", () => {
  let server: Server;
  let dataDirectory: string;

  beforeAll(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "saxi-server-test-"));
    server = await startServer(0, undefined, "", false, "200mb", dataDirectory);
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await rm(dataDirectory, { recursive: true, force: true });
  });

  // Reset state before each test to ensure isolation
  beforeEach(async () => {
    await waitForPlottingComplete(server);
    mockSerialPortInstance.clearCommands();
  });

  describe("Basic Plot Operations", () => {
    test("accept a valid plot plan and log EBB commands", async () => {
      await request(server).post("/plot").send(SIMPLE_PLAN).expect(200);

      // Wait for the plotting to actually start and commands to be logged
      await waitForCommandsLogged();

      // Check the commands that were sent to the mock serial port
      expect(mockSerialPortInstance.commands.length).toBeGreaterThan(0);
      expect(mockSerialPortInstance.commands).toContain("EM,1,1");
    });
  });

  describe("Shared presets", () => {
    test("save, share, validate, update and delete a named setup", async () => {
      const options = presetOptions(defaultPlanOptions);
      await request(server).put("/presets/Brush%20pen").send(options).expect(200);
      const list = await request(server).get("/presets").expect(200);
      expect(list.headers["cache-control"]).toBe("no-store");
      expect(list.body).toContainEqual({ name: "Brush pen", options });
      await request(server)
        .put("/presets/Brush%20pen")
        .send({ ...options, penUpHeight: 101 })
        .expect(400);
      await request(server)
        .put("/presets/Brush%20pen")
        .send({ ...options, penUpHeight: 42 })
        .expect(200);
      expect((await request(server).get("/presets")).body[0].options.penUpHeight).toBe(42);
      expect((await request(server).post("/presets/Brush%20pen/load").expect(200)).body.options.penUpHeight).toBe(42);
      await request(server).put("/presets/Other").set("Origin", "https://unrelated.example").send(options).expect(403);
      await request(server).delete("/presets/Brush%20pen").expect(204);
      expect((await request(server).get("/presets")).body).toEqual([]);
    });

    test("reject oversized settings and blank names", async () => {
      await request(server).put("/presets/%20").send(presetOptions(defaultPlanOptions)).expect(400);
      await request(server)
        .put("/presets/Large")
        .send({ extra: "x".repeat(40000) })
        .expect(413);
    });

    test("refuse loading settings during a plot or deployment", async () => {
      await request(server).put("/presets/Busy").send(presetOptions(defaultPlanOptions)).expect(200);
      await request(server).post("/plot").send(COMPLEX_PLAN).expect(200);
      await request(server).post("/presets/Busy/load").expect(409);
      await waitForPlottingComplete(server);
      await request(server).post("/maintenance").send({ updating: true }).expect(200);
      await request(server).post("/presets/Busy/load").expect(409);
      await request(server).delete("/maintenance").expect(204);
      await request(server).delete("/presets/Busy").expect(204);
      await request(server).post("/presets/Busy/load").expect(404);
    });
  });

  describe("Deployment reservation", () => {
    test("keep the reservation through a restart until explicitly released", async () => {
      await request(server).post("/maintenance").send({ updating: true }).expect(200);
      const restarted = await startServer(0, undefined, "", false, "200mb", dataDirectory);
      try {
        await request(restarted).post("/plot").send(SIMPLE_PLAN).expect(503);
        await request(restarted).delete("/maintenance").expect(204);
      } finally {
        await new Promise<void>((resolve) => restarted.close(() => resolve()));
        await request(server).delete("/maintenance").expect(204);
      }
    });

    test("expire an abandoned reservation", async () => {
      await request(server).post("/maintenance").send({ updating: true }).expect(200);
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60 * 1000);
      try {
        await request(server).post("/maintenance").send({ updating: true }).expect(200);
      } finally {
        clock.mockRestore();
        await request(server).delete("/maintenance").expect(204);
      }
    });

    test("reserve an idle server, reject new plots, and release it", async () => {
      await request(server).post("/maintenance").send({ updating: true }).expect(200);
      await request(server).post("/plot").send(SIMPLE_PLAN).expect(503);
      await request(server).post("/maintenance").send({ updating: true }).expect(409);
      await request(server).delete("/maintenance").expect(204);
      await request(server).post("/plot").send(SIMPLE_PLAN).expect(200);
      await waitForPlottingComplete(server);
    });

    test("refuse deployment while a plot is running", async () => {
      await request(server).post("/plot").send(COMPLEX_PLAN).expect(200);
      await request(server).post("/maintenance").send({ updating: true }).expect(409);
      await waitForPlottingComplete(server);
    });
  });

  describe("Error Handling", () => {
    test("handle malformed plan data", async () => {
      const invalidPlan = {
        notMotions: "invalid",
      };

      await request(server).post("/plot").send(invalidPlan).expect(500);
    });

    test("handle empty request body", async () => {
      await request(server).post("/plot").send({}).expect(500);
    });

    test("reject plot when another plot is in progress", async () => {
      // Start first plot - note the request resolves before the plot is finished
      await request(server).post("/plot").send(SIMPLE_PLAN).expect(200);

      // Immediately try second plot
      await request(server).post("/plot").send(SIMPLE_PLAN).expect(400);

      // Wait for first plot to complete to avoid affecting other tests
      await waitForPlottingComplete(server);
    });
  });

  describe("Plot Control Operations", () => {
    test("cancel plot", async () => {
      await request(server).post("/plot").send(COMPLEX_PLAN).expect(200);

      // Wait for plot to start executing motions, then cancel
      await new Promise((resolve) => setTimeout(resolve, 20));

      await request(server).post("/cancel").expect(200);

      await waitForPlottingComplete(server);
      expect(mockSerialPortInstance.commands).toContain("EM,1,1");
    });

    test("pause and resume plotting", async () => {
      await request(server).post("/plot").send(COMPLEX_PLAN).expect(200);

      await request(server).post("/pause").expect(200);

      expect(mockSerialPortInstance.commands).not.toContain("SR,60000000,0");

      await request(server).post("/resume").expect(200);

      // Wait for plot to complete
      await waitForPlottingComplete(server);

      // Verify commands were still executed
      expect(mockSerialPortInstance.commands.length).toBeGreaterThan(0);
      expect(mockSerialPortInstance.commands).toContain("EM,1,1");
      // Should have completed with motor disable (plot continued after resume)
      // FIXME: Is this a real bug on Windows?
      // expect(mockSerialPortInstance.commands).toContain('SR,60000000,0');
    }, 10000);

    test("report plot status", async () => {
      let statusResponse = await request(server).get("/plot/status").expect(200);
      expect(statusResponse.body.plotting).toBe(false);

      await request(server).post("/plot").send(COMPLEX_PLAN).expect(200);

      statusResponse = await request(server).get("/plot/status").expect(200);
      expect(statusResponse.body.plotting).toBe(true);

      await waitForPlottingComplete(server);

      statusResponse = await request(server).get("/plot/status").expect(200);
      expect(statusResponse.body.plotting).toBe(false);
    }, 10000);

    test("persist hardware change via WebSocket", async () => {
      const { port } = server.address() as AddressInfo;
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const defaultDev = await new Promise<{ path: string | null; hardware: string }>((resolve, reject) => {
        ws.once("error", reject);
        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.c === "dev") resolve(msg.p);
        });
      });
      expect(defaultDev.hardware).toBe("brushless");

      const devUpdate = new Promise<{ path: string | null; hardware: string }>((resolve) => {
        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.c === "dev" && msg.p.hardware === "v3") {
            resolve(msg.p);
          }
        });
      });

      ws.send(JSON.stringify({ c: "changeHardware", p: { hardware: "v3" } }));
      const devInfo = await devUpdate;
      expect(devInfo.hardware).toBe("v3");

      // New client connections should also receive the updated hardware
      const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
      const initialDev = await new Promise<{ path: string | null; hardware: string }>((resolve, reject) => {
        ws2.once("error", reject);
        ws2.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.c === "dev") resolve(msg.p);
        });
      });
      expect(initialDev.hardware).toBe("v3");

      // Restore default hardware for subsequent tests
      ws.send(JSON.stringify({ c: "changeHardware", p: { hardware: "brushless" } }));
      ws.close();
      ws2.close();
    });
  });
});
