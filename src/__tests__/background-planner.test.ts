import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import type { PlannerResponse } from "../background-planner.js";
import { replanGreedy } from "../massager.js";
import { defaultPlanOptions, Plan } from "../planning.js";

let source: string;
beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["src/background-planner.ts"],
    bundle: true,
    write: false,
    platform: "browser",
    target: "es2022",
  });
  // Run the browser bundle with real structured cloning and transferred buffers.
  source = `const {parentPort} = require('node:worker_threads');
    globalThis.self = {
      addEventListener: (_, listener) => parentPort.on('message', data => listener({data})),
      postMessage: (data, options) => parentPort.postMessage(data, options?.transfer)
    };
    ${bundle.outputFiles[0].text}`;
});

async function run(message: unknown) {
  const worker = new Worker(source, { eval: true });
  try {
    return await new Promise<PlannerResponse>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.postMessage(message);
    });
  } finally {
    await worker.terminate();
  }
}

describe("browser planner bundle", () => {
  it("transfers complete plans and keeps selected-layer Sets intact", async () => {
    const paths = [
      {
        points: [
          { x: 10, y: 20 },
          { x: 15, y: 22 },
        ],
        stroke: "red",
        groupId: "keep",
      },
      {
        points: [
          { x: 80, y: 50 },
          { x: 85, y: 60 },
        ],
        stroke: "blue",
        groupId: "drop",
      },
    ];
    const planOptions = { ...defaultPlanOptions, layerMode: "group" as const, selectedGroupLayers: new Set(["keep"]) };
    const response = await run({ paths, planOptions });
    expect("motions" in response).toBe(true);
    if ("motions" in response)
      expect(Plan.fromTransferable(response.motions).serialize()).toEqual(replanGreedy(paths, planOptions).serialize());
  });

  it("returns asynchronous planning failures instead of hanging", async () => {
    const response = await run({ paths: [], planOptions: null });
    expect("error" in response).toBe(true);
  });
});
