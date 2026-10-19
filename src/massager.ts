import type { Path } from "flatten-svg";
import { elideShorterThan, merge as joinNearbyPaths, reorder as sortPaths } from "optimize-paths";
import { Device, type Plan, type PlanOptions, plan, validatePlanOptions } from "./planning.js";
import { optimizePaths } from "./routing.js";
import { cropToMargins, dedupPoints, scaleToPaper } from "./util.js";
import { type Vec2, vmul, vrot } from "./vec.js";

// CSS, and thus SVG, defines 1px = 1/96th of 1in
// https://www.w3.org/TR/css-values-4/#absolute-lengths
const svgUnitsPerInch = 96;
const mmPerInch = 25.4;
const mmPerSvgUnit = mmPerInch / svgUnitsPerInch;

/** Apply the drawing settings and return the drawable paths in millimetres. */
export function preparePaths(inPaths: Path[], planOptions: PlanOptions): Vec2[][] {
  validatePlanOptions(planOptions);
  let paths: Vec2[][] = inPaths.map((path) => path.points);

  // Rotate drawing around center of paper to handle plotting portrait drawings
  // along y-axis of plotter
  // Rotate around the center of the page, but in SvgUnits (not mm)
  if (planOptions.rotateDrawing !== 0) {
    console.time("rotating paths");
    paths = paths.map((pl) =>
      pl.map((p) =>
        vrot(
          p,
          vmul({ x: planOptions.paperSize.size.x / 2, y: planOptions.paperSize.size.y / 2 }, 1 / mmPerSvgUnit),
          planOptions.rotateDrawing,
        ),
      ),
    );
    console.timeEnd("rotating paths");
  }

  // Compute scaling using _all_ the paths, so it's the same no matter what
  // layers are selected.
  if (planOptions.fitPage) {
    paths = scaleToPaper(paths, planOptions.paperSize, planOptions.marginMm);
  } else {
    paths = paths.map((ps) => ps.map((p) => vmul(p, mmPerSvgUnit)));
  }

  // Rescaling loses the stroke info, so refer back to the original paths to
  // filter based on the stroke. Rescaling doesn't change the number or order
  // of the paths.
  if (planOptions.layerMode === "group") {
    paths = paths.filter((_path, i) => planOptions.selectedGroupLayers.has(inPaths[i].groupId));
  } else if (planOptions.layerMode === "stroke") {
    paths = paths.filter((_path, i) => planOptions.selectedStrokeLayers.has(inPaths[i].stroke));
  }

  // Cropping can split or remove paths, so select layers while indices still match.
  if (!planOptions.fitPage && planOptions.cropToMargins) {
    paths = cropToMargins(paths, planOptions.paperSize, planOptions.marginMm);
  }

  if (planOptions.pointJoinRadius > 0) {
    paths = paths.map((p) => dedupPoints(p, planOptions.pointJoinRadius));
  }

  if (planOptions.sortPaths) {
    console.time("sorting paths");
    paths = sortPaths(paths);
    console.timeEnd("sorting paths");
  }

  if (planOptions.minimumPathLength > 0) {
    console.time("eliding short paths");
    paths = elideShorterThan(paths, planOptions.minimumPathLength);
    console.timeEnd("eliding short paths");
  }

  if (planOptions.pathJoinRadius > 0) {
    console.time("joining nearby paths");
    paths = joinNearbyPaths(paths, planOptions.pathJoinRadius);
    console.timeEnd("joining nearby paths");
  }

  return paths;
}

/** The greedy incumbent, also retained as the research comparison baseline. */
export function replanGreedy(inPaths: Path[], planOptions: PlanOptions): Plan {
  return planPreparedPaths(preparePaths(inPaths, planOptions), planOptions);
}

/** Create a motion plan using the selected drawing and device settings. */
export async function replan(inPaths: Path[], planOptions: PlanOptions): Promise<Plan> {
  const deadline = performance.now() + 5000;
  const paths = preparePaths(inPaths, planOptions);
  const baseline = planPreparedPaths(paths, planOptions);
  if (!planOptions.sortPaths) return baseline;
  const started = performance.now();
  try {
    const routed = await optimizePaths(paths, planOptions, deadline - 300);
    if (routed === paths) return baseline;
    const candidate = planPreparedPaths(routed, planOptions);
    // Require five net seconds after paying for this one-off optimization.
    const requiredSavings = 5 + (performance.now() - started) / 1000;
    return Number.isFinite(candidate.duration()) && baseline.duration() - candidate.duration() >= requiredSavings
      ? candidate
      : baseline;
  } catch (error) {
    console.warn("Route optimization unavailable; using the prepared drawing order.", error);
    return baseline;
  }
}

function planPreparedPaths(prepared: Vec2[][], planOptions: PlanOptions): Plan {
  const device = Device(planOptions.hardware);

  // Convert the paths to units of "steps".
  const paths = prepared.map((ps) => ps.map((p) => vmul(p, device.stepsPerMm)));

  // And finally, motion planning.
  console.time("planning pen motions");
  const theplan = plan(
    paths,
    {
      penUpPos: device.penPctToPos(planOptions.penUpHeight),
      penDownPos: device.penPctToPos(planOptions.penDownHeight),
      penDownProfile: {
        acceleration: planOptions.penDownAcceleration * device.stepsPerMm,
        maximumVelocity: planOptions.penDownMaxVelocity * device.stepsPerMm,
        corneringFactor: planOptions.penDownCorneringFactor * device.stepsPerMm,
      },
      penUpProfile: {
        acceleration: planOptions.penUpAcceleration * device.stepsPerMm,
        maximumVelocity: planOptions.penUpMaxVelocity * device.stepsPerMm,
        corneringFactor: 0,
      },
      penDropDuration: planOptions.penDropDuration,
      penLiftDuration: planOptions.penLiftDuration,
    },
    vmul(planOptions.penHome, device.stepsPerMm),
  );
  console.timeEnd("planning pen motions");

  return theplan;
}
