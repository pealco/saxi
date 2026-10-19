import { EBB, type EBBPort, type Hardware } from "./ebb.js";
import { Plan } from "./planning.js";

export interface DeviceInfo {
  path: string;
  hardware: Hardware;
}

/**
 * Driver interface for the Axi machine.
 */
export abstract class BaseDriver {
  public onprogress: (motionIdx: number) => void = () => {};
  public oncancelled: () => void = () => {};
  public onfinished: () => void = () => {};
  public onerror: (message: string, plotFailed?: boolean) => void = () => {};
  public ondevinfo: (devInfo: DeviceInfo) => void = () => {};
  public onpause: (paused: boolean) => void = () => {};
  public connected = false;
  /**
   * Called when plan loaded
   */
  public onplan: (plan: Plan) => void = () => {};

  abstract plot(plan: Plan): void;
  abstract cancel(): void;
  abstract pause(): void;
  abstract resume(): void;
  abstract setPenHeight(height: number, rate: number): void;
  abstract limp(): void;
  abstract changeHardware(hardware: Hardware): void;
  abstract name(): string;
  abstract close(): Promise<void>;
}

/**
 * WebSerial driver for the EBB. Implement interface by connecting directly to the Axi
 * machine. Used on serverless configuration (IS_WEB is set), where the control is handled
 * directly on the browser.
 */
export class WebSerialDriver extends BaseDriver {
  private _unpaused: Promise<void> | null = null;
  private _signalUnpause: (() => void) | null = null;
  private controller: AbortController | null = null;
  private _disconnectHandler: ((event: Event) => void) | null = null;

  public static async connect(port?: SerialPort, hardware: Hardware = "brushless") {
    if (!port)
      // biome-ignore lint/style/noParameterAssign: trivial
      port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x04d8, usbProductId: 0xfd92 }] });
    // baudRate ref: https://github.com/evil-mad/plotink/blob/a45739b7d41b74d35c1e933c18949ed44c72de0e/plotink/ebb_serial.py#L281
    // (doesn't specify baud rate)
    // and https://pyserial.readthedocs.io/en/latest/pyserial_api.html#serial.Serial.__init__
    // (pyserial defaults to 9600)
    await port.open({ baudRate: 9600 });
    if (!port.readable || !port.writable) {
      throw new Error("Serial port failed to open: readable/writable streams unavailable");
    }
    const { usbVendorId, usbProductId } = port.getInfo();
    const ebb = await EBB.create(port as SerialPort & EBBPort, hardware);

    const vendorId = usbVendorId?.toString(16).padStart(4, "0");
    const productId = usbProductId?.toString(16).padStart(4, "0");
    const name = `${vendorId}:${productId}`;

    const driver = new WebSerialDriver(ebb, name);
    driver._disconnectHandler = (event: Event) => {
      if (event.target === port) {
        driver.handleDisconnection();
      }
    };
    navigator.serial.addEventListener("disconnect", driver._disconnectHandler);
    driver.connected = true;

    return driver;
  }

  private _name: string;
  public name(): string {
    return this._name;
  }

  public ebb: EBB;
  private constructor(ebb: EBB, name: string) {
    super();
    this.ebb = ebb;
    this._name = name;
  }

  private handleDisconnection(): void {
    console.log("WebSerial device disconnected");
    this.connected = false;
  }

  public async close(): Promise<void> {
    this.handleDisconnection();
    if (this._disconnectHandler) {
      navigator.serial.removeEventListener("disconnect", this._disconnectHandler);
    }
    return this.ebb.close();
  }

  public async plot(plan: Plan): Promise<void> {
    if (this.controller) {
      this.onerror("Plot in progress");
      return;
    }
    this.controller = new AbortController();
    this._unpaused = null;
    try {
      const result = await this.ebb.executePlan(plan, 1, {
        signal: this.controller.signal,
        onprogress: (index) => this.onprogress(index),
        waitWhilePaused: () => this._unpaused,
      });
      this.controller = null;
      this.resume();
      if (result === "cancelled") this.oncancelled();
      else this.onfinished();
    } catch (error) {
      this.controller = null;
      this.resume();
      this.onerror(error instanceof Error ? error.message : String(error), true);
    }
  }

  public cancel(): void {
    this.controller?.abort();
    this.resume();
  }

  public pause(): void {
    if (!this.controller || this._unpaused) return;
    this._unpaused = new Promise((resolve) => {
      this._signalUnpause = resolve;
    });
    this.onpause(true);
  }

  public resume(): void {
    const signal = this._signalUnpause;
    this._unpaused = null;
    this._signalUnpause = null;
    signal?.();
    this.onpause(false);
  }

  public async setPenHeight(height: number, rate: number): Promise<void> {
    try {
      if (this.ebb.supportsSR()) await this.ebb.setServoPowerTimeout(10000, true);
      await this.ebb.setPenHeight(height, rate);
    } catch (error) {
      this.onerror(error instanceof Error ? error.message : String(error));
    }
  }

  public limp(): void {
    void this.ebb.disableMotors().catch((error: unknown) => this.onerror(String(error)));
  }

  public changeHardware(hardware: Hardware): void {
    this.ebb.changeHardware(hardware);
    this.ondevinfo({
      path: this._name,
      hardware: hardware,
    });
  }
}

/**
 * Saxi Serial driver for the EBB. Implement interface by connecting to the Axi
 * through the saxi web server, which handles the control. Used in the default
 * configuration (IS_WEB is unset).
 */
export class SaxiDriver extends BaseDriver {
  private socket!: WebSocket;
  private pingInterval: number | undefined;

  public name() {
    return "Saxi Server";
  }

  public close() {
    this.socket.close();
    return Promise.resolve();
  }

  public static async connect(): Promise<SaxiDriver> {
    const d = new SaxiDriver();
    await d.connect();
    return d;
  }

  public async connect() {
    const websocketProtocol = document.location.protocol === "https:" ? "wss" : "ws";
    this.socket = new WebSocket(`${websocketProtocol}://${document.location.host}/chat`);

    this.socket.addEventListener("open", () => {
      console.log("Connected to EBB server.");
      this.connected = true;
      this.pingInterval = window.setInterval(() => this.ping(), 30000);
    });
    this.socket.addEventListener("message", (e: MessageEvent) => {
      const msg = JSON.parse(e.data);
      switch (msg.c) {
        case "error": {
          this.onerror(msg.p.message, msg.p.plotFailed === true);
        } break;
        case "pong": {
          // nothing
        } break;
        case "progress": {
          this.onprogress(msg.p.motionIdx);
        } break;
        case "cancelled": {
          this.oncancelled();
        } break;
        case "finished": {
          this.onfinished();
        } break;
        case "dev": {
          this.ondevinfo(msg.p);
        } break;
        case "pause": {
          this.onpause(msg.p.paused);
        } break;
        case "plan": {
          this.onplan(Plan.deserialize(msg.p.motions));
        } break;
        default: {
          console.log("Unknown message from server:", msg);
        } break;
      }
    }); // biome-ignore format: compactness
    this.socket.addEventListener("error", () => {
      // TODO: something
    });
    this.socket.addEventListener("close", () => {
      console.log("Disconnected from EBB server, reconnecting in 5 seconds.");
      window.clearInterval(this.pingInterval);
      this.pingInterval = undefined;
      this.connected = false;
      setTimeout(() => void this.connect(), 5000);
    });
  }

  private async request(path: string, plan?: Plan): Promise<void> {
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: plan ? JSON.stringify(plan.serialize()) : undefined,
      });
      if (!response.ok) throw new Error(await response.text());
    } catch (error) {
      this.onerror(error instanceof Error ? error.message : String(error));
    }
  }

  public plot(plan: Plan) {
    return this.request("/plot", plan);
  }
  public cancel() {
    void this.request("/cancel");
  }
  public pause() {
    void this.request("/pause");
  }
  public resume() {
    void this.request("/resume");
  }

  public send(msg: object) {
    if (!this.connected) {
      throw new Error(`Can't send message: not connected`);
    }
    this.socket.send(JSON.stringify(msg));
  }

  public setPenHeight(height: number, rate: number) {
    this.send({ c: "setPenHeight", p: { height, rate } });
  }

  public limp() {
    this.send({ c: "limp" });
  }
  public changeHardware(hardware: Hardware) {
    this.send({ c: "changeHardware", p: { hardware } });
  }
  public ping() {
    this.send({ c: "ping" });
  }
}
