/**
 * Worker for serializing a plan.
 * Meant to be invoked through the Worker interface.
 */
import { replan } from "./massager.js";
import type { TransferredMotion } from "./planning.js";

export type PlannerResponse = { motions: TransferredMotion[] } | { error: string };

self.addEventListener("message", async (m) => {
  const { paths, planOptions } = m.data;
  try {
    const plan = await replan(paths, planOptions);
    const motions = plan.toTransferable();
    const buffers = motions.filter((m) => m.type === "xy").flatMap((m) => [m.cols, m.ts, m.ss]);
    self.postMessage({ motions } satisfies PlannerResponse, { transfer: buffers });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) } satisfies PlannerResponse);
  }
});
