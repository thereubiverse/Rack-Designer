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
