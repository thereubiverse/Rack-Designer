import { Faceplate } from "@/features/device-library/faceplate/Faceplate";
import type { Face, PortGroup } from "@/domain/faceplate";

function g(over: Partial<PortGroup> & { id: string }): PortGroup {
  return {
    media: "copper",
    connectorType: "RJ45",
    idPrefix: "",
    countingDirection: "ltr",
    rows: 1,
    cols: 1,
    gridX: 0,
    gridY: 0,
    colSpacing: 2,
    rowSpacing: 3,
    portOverrides: {},
    ...over,
  };
}

// Reproduces the mockup's reference device left-to-right.
const referenceFace: Face = {
  elements: [],
  portGroups: [
    g({ id: "usbc", media: "usb_c", connectorType: "USB-C", cols: 1, gridX: 8, gridY: 8 }),
    g({ id: "usba", media: "usb_a", connectorType: "USB-A", cols: 1, gridX: 44, gridY: 8 }),
    g({ id: "cop-under", media: "copper", cols: 1, gridX: 44, gridY: 34 }),
    g({
      id: "cop8",
      cols: 8,
      gridX: 84,
      gridY: 20,
      portOverrides: { 0: { flipped: true }, 1: { flipped: true }, 2: { flipped: true }, 3: { flipped: true }, 4: { flipped: true }, 5: { flipped: true }, 6: { flipped: true }, 7: { flipped: true } },
    }),
    g({ id: "cop2", cols: 2, gridX: 300, gridY: 20, portOverrides: { 0: { flipped: true }, 1: { flipped: true } } }),
    g({ id: "sfp2", media: "sfp", connectorType: "SFP+", cols: 2, gridX: 380, gridY: 20 }),
  ],
};

export default function FaceplatePreviewPage() {
  return (
    <main style={{ fontFamily: "Inter, system-ui, sans-serif", padding: 32, color: "#1f2328" }}>
      <h1 style={{ fontSize: 18, fontWeight: 700 }}>Faceplate renderer — preview</h1>

      <h2 style={{ fontSize: 14, marginTop: 24 }}>10.6″ · 1U · Rack Mounted</h2>
      <div style={{ background: "#f6f7f9", border: "1px solid #eceef1", borderRadius: 12, padding: 16, display: "inline-block" }}>
        <Faceplate face={referenceFace} widthIn={10.6} rackUnits={1} rackMounted side="FRONT" />
      </div>

      <h2 style={{ fontSize: 14, marginTop: 24 }}>10.6″ · 1U · Stand-alone (ears off)</h2>
      <div style={{ background: "#f6f7f9", border: "1px solid #eceef1", borderRadius: 12, padding: 16, display: "inline-block" }}>
        <Faceplate face={referenceFace} widthIn={10.6} rackUnits={1} rackMounted={false} side="FRONT" />
      </div>
    </main>
  );
}
