/**
 * EbbTransport — abstract line-oriented transport to the EBB firmware.
 *
 * The EBB speaks a simple ASCII protocol: we write a command string ending in
 * CR, and it replies with one or more lines terminated by CR/LF. Any transport
 * that can do bidirectional byte-stream I/O can drive our EbbCommands layer.
 *
 * Two implementations ship with nib:
 *   - NodeSerialTransport — Node/Bun, uses stty + fs.openSync + createReadStream
 *   - WebSerialTransport  — browser, wraps a WebSerial `SerialPort` instance
 *
 * New transports only need to implement three methods. Protocol semantics
 * (timeouts, retries, pen state) live above this layer in EbbCommands.
 */

export interface EbbTransport {
  /** True while the underlying port is open for reading and writing. */
  readonly isOpen: boolean

  /**
   * Send raw bytes to the device. No trailing CR is added — the caller is
   * responsible for formatting the full command including its terminator.
   * Accepts a string for convenience (UTF-8 encoded).
   */
  write(bytes: Uint8Array | string): Promise<void>

  /**
   * Read one line (up to CR or LF, paired consumed if present). Rejects if
   * no full line arrives within `timeoutMs`. Returned string does NOT include
   * the terminator.
   */
  readLine(timeoutMs: number): Promise<string>

  /** Close the underlying port. Idempotent. */
  close(): Promise<void>
}
