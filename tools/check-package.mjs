import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { server } from "../index.mjs";
import { parsePaperSize, parseSvg } from "../dist/server/cli.js";
import { EBB } from "../dist/server/ebb.js";
import { AxidrawBrushlessFast, plan } from "../dist/server/planning.js";
import { createSimulatedSerialPort } from "../dist/server/simulated-serial.js";
import { flattenSVG } from "flatten-svg";

// CI runs this after removing development dependencies. Never open real hardware.
assert.equal(typeof server, "function");
assert.equal(parsePaperSize("1x1in").size.x, 25.4);
const paths = flattenSVG(parseSvg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M10 10L20 20"/></svg>'));
assert.equal(paths.length, 1);
const ebb = await EBB.create(createSimulatedSerialPort());
try {
  assert.equal(
    await ebb.executePlan(
      plan(
        paths.map((path) => path.points),
        AxidrawBrushlessFast,
      ),
    ),
    "finished",
  );
} finally {
  await ebb.close();
}
const cli = spawnSync(process.execPath, ["cli.mjs", "--help"], { encoding: "utf8" });
assert.equal(cli.status, 0, cli.stderr);
assert.match(cli.stdout, /plot <file>/);
console.log("Production entry point, CLI, SVG parser, and simulated plotting passed.");
