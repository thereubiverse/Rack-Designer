import "@testing-library/jest-dom/vitest";

// jsdom does not implement PointerEvent (https://github.com/jsdom/jsdom/issues/2527).
// Polyfill it as a thin MouseEvent subclass so pointer-drag tests get real
// clientX/clientY values instead of falling back to a bare Event.
if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    public pointerId: number;
    public pointerType: string;
    public isPrimary: boolean;

    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
      this.pointerType = params.pointerType ?? "mouse";
      this.isPrimary = params.isPrimary ?? true;
    }
  }
  // @ts-expect-error -- assigning a test polyfill onto the jsdom window
  window.PointerEvent = PointerEventPolyfill;
}

// jsdom's Blob/File implementation does not implement `arrayBuffer()` (unlike real browsers and
// Node's own Blob). Server actions that read an uploaded File's bytes — e.g. the avatar upload —
// call `file.arrayBuffer()`, which is otherwise unavailable under jsdom. FileReader IS implemented,
// so use it to fill the gap rather than changing production code to work around a test-only hole.
if (typeof Blob !== "undefined" && typeof Blob.prototype.arrayBuffer !== "function") {
  Blob.prototype.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}
