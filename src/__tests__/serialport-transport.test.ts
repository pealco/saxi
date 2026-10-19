import { describe, expect, it, vi } from "vitest";
import { SerialPort as NodeSerialPort } from "serialport";
import { EBB } from "../ebb.js";
import { SerialPortSerialPort } from "../serialport-serialport.js";

vi.mock("serialport", async () => {
  const { Duplex } = await import("node:stream");
  class MockPort extends Duplex {
    static last: MockPort;
    options: { endOnClose?: boolean };
    constructor(options: { endOnClose?: boolean }, opened: () => void) {
      super();
      this.options = options;
      MockPort.last = this;
      queueMicrotask(opened);
    }
    _read() {}
    _write(bytes: Buffer, _encoding: string, done: () => void) {
      if (bytes.toString().trim() === "V") this.push("test 2.5.3\r\n");
      done();
    }
    close(done: () => void = () => {}) {
      this.emit("close");
      if (this.options.endOnClose) this.push(null);
      done();
    }
  }
  return { SerialPort: MockPort };
});

describe("Node serial stream bridge", () => {
  it("closes even while a native read is waiting for bytes", async () => {
    const port = new SerialPortSerialPort("/dev/ttyMOCK");
    await port.open({ baudRate: 9600 });
    const ebb = await EBB.create(port);
    await ebb.close();
    expect(port.connected).toBe(false);
    expect(port.readable.locked).toBe(false);
  }, 1000);

  it("rejects pending commands when the native port closes", async () => {
    const port = new SerialPortSerialPort("/dev/ttyMOCK");
    await port.open({ baudRate: 9600 });
    const ebb = await EBB.create(port);
    const rejected = expect(ebb.command("EM,1,1")).rejects.toThrow("Error in response to command 'EM,1,1'");
    (NodeSerialPort as any).last.close();
    await rejected;
  }, 1000);
});
