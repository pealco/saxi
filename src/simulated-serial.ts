import type { EBBPort } from "./ebb.js";

export function createSimulatedSerialPort(): EBBPort {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const encoder = new TextEncoder();
  return {
    readable: new ReadableStream({
      start(c) {
        controller = c;
      },
      cancel() {
        closed = true;
      },
    }),
    writable: new WritableStream({
      async write(chunk) {
        const command = new TextDecoder().decode(chunk).trim();
        await new Promise((resolve) => setTimeout(resolve, 2));
        if (closed) throw new Error("Simulated serial port closed");
        const response = command === "V" ? "simulated 2.5.3" : command === "QM" ? "QM,0,0,0,0" : "OK";
        controller.enqueue(encoder.encode(`${response}\r\n`));
      },
    }),
    async close() {
      if (!closed) {
        closed = true;
        controller.close();
      }
    },
  };
}
