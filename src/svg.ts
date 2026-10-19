const svgNamespace = "http://www.w3.org/2000/svg";
const elements = new Set(["svg", "g", "a", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);
const attributes = new Set([
  "id",
  "viewBox",
  "preserveAspectRatio",
  "transform",
  "x",
  "y",
  "width",
  "height",
  "d",
  "points",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "stroke",
  "fill",
]);
const safePaint = /^(?:[a-z]+|#[0-9a-f]+|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+/-]+\))$/i;

/** Copy only the geometry flatten-svg supports; never attach imported active content. */
export function sanitizeSvg(source: Element, document: Document): SVGSVGElement {
  if (source.namespaceURI !== svgNamespace || source.localName !== "svg") throw new Error("Expected an SVG drawing");
  function copy(node: Element): Element {
    const clean = document.createElementNS(svgNamespace, node.localName);
    for (const attr of Array.from(node.attributes)) {
      if (
        attr.namespaceURI === null &&
        attributes.has(attr.name) &&
        (!["stroke", "fill"].includes(attr.name) || safePaint.test(attr.value.trim()))
      ) {
        clean.setAttribute(attr.name, attr.value);
      }
    }
    // Stroke is used for layers; arbitrary CSS could load URLs or affect the page.
    const stroke = (node as SVGElement).style?.stroke;
    if (stroke && safePaint.test(stroke.trim())) clean.setAttribute("stroke", stroke);
    for (const child of Array.from(node.children)) {
      if (child.namespaceURI === svgNamespace && elements.has(child.localName)) clean.appendChild(copy(child));
    }
    return clean;
  }
  return copy(source) as SVGSVGElement;
}
