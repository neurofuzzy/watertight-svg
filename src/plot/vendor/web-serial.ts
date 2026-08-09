/**
 * WebSerialTransport — browser implementation of EbbTransport using the
 * WebSerial API (Chromium family: Chrome, Edge, Opera). Wraps a SerialPort
 * object you've already acquired via `navigator.serial.requestPort(...)`
 * and opened at 115200 baud.
 *
 * Minimal DOM-free typing: declared locally so this file compiles in a
 * Node/Bun project without adding "dom" to tsconfig's lib list. At runtime
 * in a browser, real WebSerial objects satisfy these shapes.
 *
 * WebSerial spec: https://wicg.github.io/serial/
 * Availability: Chrome 89+, Edge 89+, Opera 75+. Not in Firefox or Safari.
 */

import type { EbbTransport } from './transport.ts'

// ─── Minimal structural types matching the WebSerial API ─────────────────────

interface WebSerialPort {
  readable: ReadableByteStream | null
  writable: WritableByteStream | null
  close(): Promise<void>
}

interface ReadableByteStream {
  getReader(): ReadableStreamReader
}

interface ReadableStreamReader {
  read(): Promise<{ value?: Uint8Array; done: boolean }>
  releaseLock(): void
  cancel(reason?: unknown): Promise<void>
}

interface WritableByteStream {
  getWriter(): WritableStreamWriter
}

interface WritableStreamWriter {
  write(chunk: Uint8Array): Promise<void>
  releaseLock(): void
  close(): Promise<void>
}

/**
 * Filter for `navigator.serial.requestPort({ filters })` that matches the
 * AxiDraw's EBB USB identification (Microchip PIC: VID 0x04d8, PID 0xfd92
 * or 0xfd93). Use when prompting the user to select a device.
 */
export const EBB_USB_FILTERS = [
  { usbVendorId: 0x04d8, usbProductId: 0xfd92 },
  { usbVendorId: 0x04d8, usbProductId: 0xfd93 },
] as const

// ─── WebSerialTransport ──────────────────────────────────────────────────────

export class WebSerialTransport implements EbbTransport {
  private port: WebSerialPort | null
  private reader: ReadableStreamReader | null = null
  private writer: WritableStreamWriter | null = null
  private lineBuffer = ''
  private readLoopPromise: Promise<void> | null = null
  /**
   * Queue of parsed lines waiting to be consumed by readLine(). We always
   * buffer what the device sends — if no reader is currently awaiting, the
   * line sits here until one is.
   */
  private lineQueue: string[] = []
  /** A pending readLine's resolver, or null if no one is waiting. */
  private pendingResolver: ((line: string) => void) | null = null

  private constructor(port: WebSerialPort) {
    this.port = port
  }

  /**
   * Connect using an already-opened SerialPort. Starts the read loop.
   * Typical flow:
   *
   *   const port = await navigator.serial.requestPort({
   *     filters: EBB_USB_FILTERS,
   *   })
   *   await port.open({ baudRate: 115200 })
   *   const transport = await WebSerialTransport.connect(port)
   */
  static async connect(port: WebSerialPort): Promise<WebSerialTransport> {
    if (!port.readable || !port.writable) {
      throw new Error('SerialPort must be opened (await port.open(...)) before passing to WebSerialTransport')
    }
    const t = new WebSerialTransport(port)
    t.reader = port.readable.getReader()
    t.writer = port.writable.getWriter()
    // Start reading in the background. Errors propagate to any pending
    // readLine callers via the queue logic (the promise also rejects at
    // close time if there's an IO fault).
    t.readLoopPromise = t.runReadLoop()
    // Drain the power-on banner / stale buffer for 500ms, then discard.
    await sleep(500)
    t.lineBuffer = ''
    t.lineQueue.length = 0
    return t
  }

  get isOpen(): boolean { return this.port !== null }

  async write(bytes: Uint8Array | string): Promise<void> {
    if (!this.writer) throw new Error('WebSerialTransport is not open')
    const payload = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
    await this.writer.write(payload)
  }

  async readLine(timeoutMs: number): Promise<string> {
    if (!this.isOpen) throw new Error('WebSerialTransport is not open')
    const queued = this.lineQueue.shift()
    if (queued !== undefined) return queued
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResolver = null
        reject(new Error(`WebSerial read timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pendingResolver = (line) => {
        clearTimeout(timer)
        resolve(line)
      }
    })
  }

  async close(): Promise<void> {
    const port = this.port
    if (!port) return
    this.port = null
    // Stop the read loop; release reader lock so close() can proceed.
    try { await this.reader?.cancel() } catch { /* ignore */ }
    try { this.reader?.releaseLock() } catch { /* ignore */ }
    try { this.writer?.releaseLock() } catch { /* ignore */ }
    this.reader = null
    this.writer = null
    try { await port.close() } catch { /* ignore */ }
    // Wait for the background read loop to exit so we don't leak promises.
    try { await this.readLoopPromise } catch { /* ignore */ }
    this.readLoopPromise = null
  }

  // ── Internal: background byte reader → line queue ─────────────────────────

  private async runReadLoop(): Promise<void> {
    const reader = this.reader
    if (!reader) return
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        if (!value) continue
        this.lineBuffer += decoder.decode(value)
        this.flushLines()
      }
    } catch {
      // Read loop exits on cancel() or stream error — surface as a rejection
      // for any pending readLine caller.
      if (this.pendingResolver) {
        const resolver = this.pendingResolver
        this.pendingResolver = null
        // Use a sentinel value — resolvers don't carry error state;
        // the pending readLine's timeout will fire instead if nothing
        // else drains it. This is the trade-off for keeping the interface
        // simple; a future revision could use an error queue.
        resolver.call(null, '')
      }
    }
  }

  private flushLines(): void {
    let idx: number
    while ((idx = this.lineBuffer.search(/[\r\n]/)) >= 0) {
      const line = this.lineBuffer.slice(0, idx).trim()
      const c = this.lineBuffer[idx]
      const next = this.lineBuffer[idx + 1]
      const skip = (c === '\r' && next === '\n') || (c === '\n' && next === '\r') ? 2 : 1
      this.lineBuffer = this.lineBuffer.slice(idx + skip)
      if (line.length === 0) continue
      if (this.pendingResolver) {
        const resolver = this.pendingResolver
        this.pendingResolver = null
        resolver(line)
      } else {
        this.lineQueue.push(line)
      }
    }
  }
}

// ─── Convenience: prompt + open + wrap ───────────────────────────────────────

/**
 * One-call helper for browser apps: prompt the user to pick an EBB device,
 * open it at 115200 baud, and return a connected transport ready for use
 * with `plotStrokes` / `plot` / `EBBBackend`.
 *
 * Throws if WebSerial isn't available (Firefox, Safari, or an HTTP
 * (not HTTPS) context in some browsers) or if the user cancels the prompt.
 *
 *   const transport = await requestEbbPort()
 *   await plotStrokes(strokes, { transport, profile })
 */
export async function requestEbbPort(
  serial: { requestPort: (options: { filters: readonly unknown[] }) => Promise<WebSerialPort> }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    = (globalThis as any).navigator?.serial,
): Promise<WebSerialTransport> {
  if (!serial || typeof serial.requestPort !== 'function') {
    throw new Error(
      'WebSerial is not available. ' +
      'nib\'s browser transport requires Chrome/Edge/Opera on a secure context (HTTPS).',
    )
  }
  const port = await serial.requestPort({ filters: EBB_USB_FILTERS })
  // `port.open` is on the SerialPort interface; widen the type locally since
  // WebSerialPort keeps the minimal shape needed by the transport.
  await (port as unknown as { open(opts: { baudRate: number }): Promise<void> }).open({ baudRate: 115200 })
  return WebSerialTransport.connect(port)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
