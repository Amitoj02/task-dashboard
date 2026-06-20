/**
 * A byte-bounded FIFO buffer that retains only the most recent `maxBytes` of
 * appended data.
 *
 * Used per running instance to keep a small tail of recent output in the
 * extension host (for replay when a terminal is revealed and for restart
 * context) while the full scrollback lives in the terminal renderer. Chunks are
 * stored as raw {@link Buffer}s so multibyte UTF-8 sequences are never split
 * mid-character inside the core; stringification happens only at the host
 * boundary.
 *
 * @remarks Part of the host-free core. Must not import `vscode` or
 * `child_process`.
 */

/**
 * A fixed-capacity, byte-bounded ring of buffered output.
 *
 * Appending past the cap evicts whole oldest chunks first, then trims the front
 * of the oldest surviving chunk so the retained size never exceeds `maxBytes`.
 */
export class RingBuffer {
  /** Retained chunks, oldest first. */
  private chunks: Buffer[] = [];

  /** Sum of `chunks[i].length`, kept in step with {@link chunks}. */
  private size = 0;

  /** The hard cap on retained bytes (always at least 1). */
  private readonly maxBytes: number;

  /**
   * @param maxBytes - The maximum number of bytes to retain. Values below 1 are
   *   clamped to 1 so the buffer always keeps something.
   */
  public constructor(maxBytes: number) {
    this.maxBytes = Math.max(1, Math.floor(maxBytes));
  }

  /**
   * Appends a chunk, evicting old data so the total stays within the cap.
   *
   * @param chunk - The bytes to append.
   */
  public append(chunk: Buffer): void {
    if (chunk.length === 0) {
      return;
    }

    // A single chunk larger than the cap: keep only its tail.
    if (chunk.length >= this.maxBytes) {
      this.chunks = [chunk.subarray(chunk.length - this.maxBytes)];
      this.size = this.maxBytes;
      return;
    }

    this.chunks.push(chunk);
    this.size += chunk.length;
    this.evict();
  }

  /**
   * Returns the retained tail as a single contiguous buffer.
   *
   * @returns A fresh {@link Buffer} (empty if nothing is retained). The caller
   *   owns the copy; mutating it does not affect the ring.
   */
  public toBuffer(): Buffer {
    if (this.chunks.length === 0) {
      return Buffer.alloc(0);
    }
    return Buffer.concat(this.chunks, this.size);
  }

  /** @returns The number of bytes currently retained. */
  public get length(): number {
    return this.size;
  }

  /** Drops all retained data. */
  public clear(): void {
    this.chunks = [];
    this.size = 0;
  }

  /** Evicts/trims oldest chunks until the retained size is within the cap. */
  private evict(): void {
    while (this.size > this.maxBytes && this.chunks.length > 0) {
      const overflow = this.size - this.maxBytes;
      const oldest = this.chunks[0];
      if (oldest.length <= overflow) {
        // Drop the whole oldest chunk.
        this.chunks.shift();
        this.size -= oldest.length;
      } else {
        // Trim the front of the oldest chunk to shed exactly the overflow.
        this.chunks[0] = oldest.subarray(overflow);
        this.size -= overflow;
      }
    }
  }
}
