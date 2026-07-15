"use client";
// The endpoint visualisation. Every kind draws faceplate-style through the existing pure
// renderFace — a described endpoint via its built-in face, a switch via its REAL snapshot face.
import { renderFace } from "@/features/device-library/faceplate/Faceplate";
import { frameDims, CELL_W, PX_PER_IN } from "@/domain/faceplate-geometry";
import type { Face } from "@/domain/faceplate";
import { faceForDescribed, ENDPOINT_GROUP_ID } from "./endpointFaces";
import type { SiteSwitchTarget } from "./siteScope";

const BLUE = "#1a55d8";

function FaceSvg({ face, widthIn, rackUnits, rackMounted, highlightIndex }: {
  face: Face;
  widthIn: number; rackUnits: number; rackMounted: boolean; highlightIndex?: number;
}) {
  const opts = { widthIn, rackUnits, rackMounted };
  const dims = frameDims(opts);
  const highlight = highlightIndex === undefined
    ? undefined
    : [{ groupId: ENDPOINT_GROUP_ID, portIndex: highlightIndex, color: BLUE }];
  return (
    <svg data-testid="endpoint-face" viewBox={`0 0 ${dims.frameWidthPx} ${dims.heightPx}`}
      className="h-auto w-full" preserveAspectRatio="xMidYMid meet">
      {renderFace(face, opts, highlight)}
    </svg>
  );
}

export type EndpointFaceViewProps =
  | { kind: "described"; typeCode: string; portCount: number; landingPortIndex: number; landingPortLabel: string }
  | { kind: "device"; target: SiteSwitchTarget }
  | { kind: "rack"; rackCode: string };

export function EndpointFaceView(props: EndpointFaceViewProps) {
  if (props.kind === "described") {
    const face = faceForDescribed(props);
    const cols = face.portGroups[0].cols;
    // Just wide enough for the ports, with a port's width of margin each side.
    const widthIn = ((cols + 2) * CELL_W) / PX_PER_IN;
    return <FaceSvg face={face} widthIn={widthIn} rackUnits={1} rackMounted={false}
      highlightIndex={props.landingPortIndex} />;
  }
  if (props.kind === "device") {
    const { target } = props;
    if (!target.frontFace) {
      return <div data-testid="endpoint-face" className="rounded border border-neutral-200 p-3 text-xs text-neutral-500">
        {target.rackCode}/{target.code} — no face recorded
      </div>;
    }
    return <FaceSvg face={target.frontFace} widthIn={19} rackUnits={target.heightU ?? 1} rackMounted />;
  }
  // kind === "rack" — a small rack outline with its code.
  return (
    <svg data-testid="endpoint-face" viewBox="0 0 120 90" className="h-auto w-full">
      <rect x={8} y={4} width={104} height={82} rx={4} fill="none" stroke="#3f3f46" strokeWidth={2} />
      <rect x={18} y={12} width={10} height={66} fill="#a3a3a3" />
      <rect x={92} y={12} width={10} height={66} fill="#a3a3a3" />
      <text x={60} y={50} textAnchor="middle" dominantBaseline="central"
        fontSize={18} fontWeight={600} fill="#3f3f46">{props.rackCode}</text>
    </svg>
  );
}
