import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { EBB } from "../ebb.js";
import { AxidrawBrushlessFast, Plan, plan } from "../planning.js";
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
      original.startServer(port, hardware, "/dev/ttyMOCK", ...args),
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
const SIMPLE_PLAN = plan(SIMPLE_PATHS, AxidrawBrushlessFast).serialize();
const COMPLEX_PLAN = plan(COMPLEX_PATHS, AxidrawBrushlessFast).serialize();

function nextMessage(ws: WebSocket, command: string): Promise<any> {
  return new Promise((resolve) => {
    const receive = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString());
      if (message.c !== command) return;
      ws.off("message", receive);
      resolve(message.p);
    };
    ws.on("message", receive);
  });
}

function rejectedUpgrade(server: Server, headers: Record<string, string>): Promise<number | undefined> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    ws.on("error", reject);
    ws.on("unexpected-response", (_request, response) => {
      resolve(response.statusCode);
      response.resume();
      ws.terminate();
    });
    ws.on("open", () => {
      ws.terminate();
      reject(new Error("Unexpectedly accepted WebSocket"));
    });
  });
}

// Helper function to wait for plotting to complete
async function waitForPlottingComplete(server: Server, timeout = 10000): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const response = await request(server).get("/plot/status");
    if (!response.body.plotting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Plot did not finish");
}

async function waitForCommandsLogged(command = "EM,1,1", timeout = 5000): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (mockSerialPortInstance.commands.includes(command)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Command not received: ${command}`);
}

describe("Plot Endpoint Test Suite", () => {
  let server: Server;

  beforeAll(async () => {
    server = await startServer(0); // Use port 0 for dynamic port assignment
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
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

  describe("Error Handling", () => {
    test("rejects foreign origins and DNS rebinding before hardware access", async () => {
      expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
      await request(server).post("/cancel").set("Origin", "https://example.invalid").expect(403);
      await request(server).get("/plot/status").set("Host", "example.invalid").expect(403);
      expect(await rejectedUpgrade(server, { Origin: "https://example.invalid" })).toBe(403);
      expect(mockSerialPortInstance.commands).toEqual([]);
    });

    test("reports invalid WebSocket messages and continues accepting valid messages", async () => {
      const { port } = server.address() as AddressInfo;
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      try {
        await once(ws, "open");
        for (const data of [
          "{",
          "null",
          '{"c":"setPenHeight","p":{"height":-1,"rate":1}}',
          '{"c":"changeHardware","p":{"hardware":"invalid"}}',
        ]) {
          const error = nextMessage(ws, "error");
          ws.send(data);
          expect((await error).message).toBeTruthy();
        }
        const pong = nextMessage(ws, "pong");
        ws.send('{"c":"ping"}');
        await pong;
        expect(mockSerialPortInstance.commands).toEqual([]);
      } finally {
        ws.terminate();
      }
    });

    test("handle malformed plan data", async () => {
      const invalidPlan = {
        notMotions: "invalid",
      };

      await request(server).post("/plot").send(invalidPlan).expect(400);
    });

    test("handle empty request body", async () => {
      await request(server).post("/plot").send({}).expect(400);
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
    test("restores plans on reconnect and stays busy until hardware cleanup finishes", async () => {
      let release = () => {};
      const idle = new Promise<void>((resolve) => {
        release = resolve;
      });
      const wait = vi.spyOn(EBB.prototype, "waitUntilMotorsIdle").mockImplementationOnce(() => idle);
      let ws: WebSocket | undefined;
      try {
        await request(server).post("/plot").send(SIMPLE_PLAN).expect(200);
        await vi.waitFor(() => expect(wait).toHaveBeenCalled());
        expect((await request(server).get("/plot/status")).body.plotting).toBe(true);
        const { port } = server.address() as AddressInfo;
        ws = new WebSocket(`ws://127.0.0.1:${port}`);
        const restored = await nextMessage(ws, "plan");
        expect(Plan.deserialize(restored.motions).serialize()).toEqual(SIMPLE_PLAN);
        const finished = nextMessage(ws, "finished");
        const rejected = nextMessage(ws, "error");
        ws.send('{"c":"limp"}');
        expect((await rejected).message).toMatch(/during a plot/);
        expect(mockSerialPortInstance.commands).not.toContain("EM,0,0");
        release();
        await finished;
        expect(mockSerialPortInstance.commands.at(-1)).toBe("EM,0,0");
        expect((await request(server).get("/plot/status")).body.plotting).toBe(false);
      } finally {
        release();
        ws?.terminate();
        await waitForPlottingComplete(server);
        wait.mockRestore();
      }
    });

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

    test.each(["v3", "idraw-h-se"])("persist %s hardware change via WebSocket", async (hardware) => {
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
          if (msg.c === "dev" && msg.p.hardware === hardware) {
            resolve(msg.p);
          }
        });
      });

      ws.send(JSON.stringify({ c: "changeHardware", p: { hardware } }));
      const devInfo = await devUpdate;
      expect(devInfo.hardware).toBe(hardware);

      // New client connections should also receive the updated hardware
      const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
      const initialDev = await new Promise<{ path: string | null; hardware: string }>((resolve, reject) => {
        ws2.once("error", reject);
        ws2.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.c === "dev") resolve(msg.p);
        });
      });
      expect(initialDev.hardware).toBe(hardware);

      // Restore default hardware for subsequent tests
      const restored = nextMessage(ws, "dev");
      ws.send(JSON.stringify({ c: "changeHardware", p: { hardware: "brushless" } }));
      await restored;
      ws.close();
      ws2.close();
    });
  });
});

describe("authenticated network access", () => {
  let server: Server;
  const authorization = `Basic ${Buffer.from("saxi:test-password").toString("base64")}`;
  beforeAll(async () => {
    vi.stubEnv("SAXI_TOKEN", "test-password");
    try {
      server = await startServer(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("requires credentials on HTTP and WebSocket, including the UI", async () => {
    expect((server.address() as AddressInfo).address).toBe("0.0.0.0");
    await request(server).get("/").expect("WWW-Authenticate", /Basic/).expect(401);
    await request(server).post("/cancel").expect(401);
    await request(server).get("/plot/status").set("Authorization", "Basic invalid").expect(401);
    await request(server).get("/plot/status").set("Authorization", authorization).expect(200);
    expect(await rejectedUpgrade(server, {})).toBe(401);
    expect(await rejectedUpgrade(server, { Authorization: authorization, Origin: "https://example.invalid" })).toBe(
      403,
    );
    const { port } = server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: authorization, Origin: `http://127.0.0.1:${port}` },
    });
    try {
      expect((await nextMessage(ws, "dev")).hardware).toBe("brushless");
    } finally {
      ws.terminate();
    }
  });

  test("requires a password before enabling cross-origin control", async () => {
    vi.stubEnv("SAXI_TOKEN", "");
    try {
      const actual = await vi.importActual<typeof import("../server.js")>("../server.js");
      await expect(actual.startServer(0, "brushless", "/dev/ttyMOCK", true)).rejects.toThrow("requires SAXI_TOKEN");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
