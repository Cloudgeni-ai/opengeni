const MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_ENCODINGS = 4_096;
const MAX_FENCE_BYTES = 64;
const DENIED_ENCODINGS = new Set([
  0xc0a1e5ce, // Extended clipboard auto-negotiation sends ClientCutText.
  -309 >>> 0, // XVP power control.
  -308 >>> 0, // Client-driven display resize.
  -316 >>> 0, // Extended pointer messages are outside the fixed input scope.
]);

export class RfbClientPermissionError extends Error {}

/** Parse the client's RFB stream before forwarding any complete message.
 * The private x11vnc endpoint uses None security. Pixel negotiation remains
 * available to view grants; only an explicitly scoped grant permits key and
 * pointer messages. Clipboard, power and display changes use canonical actions.
 */
export class RfbClientFilter {
  private pending = new Uint8Array(0);
  private phase: "version" | "security" | "init" | "messages" = "version";

  constructor(private readonly inputAllowed: boolean) {}

  accept(bytes: Uint8Array): Uint8Array[] {
    if (this.pending.byteLength + bytes.byteLength > MAX_BUFFER_BYTES) {
      throw new RfbClientPermissionError("RFB client buffer exceeded");
    }
    const joined = new Uint8Array(this.pending.byteLength + bytes.byteLength);
    joined.set(this.pending);
    joined.set(bytes, this.pending.byteLength);
    const messages: Uint8Array[] = [];
    let offset = 0;
    while (offset < joined.byteLength) {
      const remaining = joined.subarray(offset);
      const phase = this.phase;
      const length = this.messageLength(remaining);
      if (length === null || remaining.byteLength < length) break;
      const message = remaining.slice(0, length);
      // Viewing a screen never authorizes disconnecting its other viewers.
      if (phase === "init") message[0] = 1;
      messages.push(
        this.phase === "messages" && message[0] === 2 ? this.pixelEncodings(message) : message,
      );
      offset += length;
    }
    this.pending = joined.slice(offset);
    return messages;
  }

  private messageLength(bytes: Uint8Array): number | null {
    if (this.phase === "version") {
      if (bytes.byteLength < 12) return null;
      const version = new TextDecoder().decode(bytes.subarray(0, 12));
      if (!/^RFB 003\.(003|007|008)\n$/u.test(version)) {
        throw new RfbClientPermissionError("unsupported RFB client version");
      }
      this.phase = version === "RFB 003.003\n" ? "init" : "security";
      return 12;
    }
    if (this.phase === "security") {
      if (bytes[0] !== 1) throw new RfbClientPermissionError("unsupported RFB security selection");
      this.phase = "init";
      return 1;
    }
    if (this.phase === "init") {
      if (bytes[0] !== 0 && bytes[0] !== 1) {
        throw new RfbClientPermissionError("invalid RFB client initialization");
      }
      this.phase = "messages";
      return 1;
    }
    switch (bytes[0]) {
      case 0: // SetPixelFormat.
        return 20;
      case 2: {
        // SetEncodings.
        if (bytes.byteLength < 4) return null;
        const count = bytes[2]! * 256 + bytes[3]!;
        if (count > MAX_ENCODINGS) throw new RfbClientPermissionError("RFB encoding list exceeded");
        return 4 + count * 4;
      }
      case 3: // FramebufferUpdateRequest.
      case 150: // EnableContinuousUpdates.
        return 10;
      case 248: {
        // Fence, including its bounded opaque payload.
        if (bytes.byteLength < 9) return null;
        const length = bytes[8]!;
        if (length > MAX_FENCE_BYTES)
          throw new RfbClientPermissionError("RFB fence payload exceeded");
        return 9 + length;
      }
      case 4: // KeyEvent.
        this.requireInput();
        return 8;
      case 5: // PointerEvent.
        this.requireInput();
        if (bytes.byteLength < 2) return null;
        if (bytes[1]! & 0x80)
          throw new RfbClientPermissionError("extended RFB pointer input is not permitted");
        return 6;
      case 255: // QEMU ExtendedKeyEvent; no other extension is input-authorized.
        this.requireInput();
        if (bytes.byteLength < 2) return null;
        if (bytes[1] !== 0) throw new RfbClientPermissionError("unsupported RFB client extension");
        return 12;
      default:
        throw new RfbClientPermissionError("RFB client message is not permitted");
    }
  }

  private pixelEncodings(message: Uint8Array): Uint8Array {
    const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
    const encodings: number[] = [];
    for (let offset = 4; offset < message.byteLength; offset += 4) {
      const encoding = view.getUint32(offset);
      if (!DENIED_ENCODINGS.has(encoding)) encodings.push(encoding);
    }
    const filtered = new Uint8Array(4 + encodings.length * 4);
    filtered[0] = 2;
    const output = new DataView(filtered.buffer);
    output.setUint16(2, encodings.length);
    for (let index = 0; index < encodings.length; index += 1)
      output.setUint32(4 + index * 4, encodings[index]!);
    return filtered;
  }

  private requireInput(): void {
    if (!this.inputAllowed) throw new RfbClientPermissionError("RFB input is not permitted");
  }
}
