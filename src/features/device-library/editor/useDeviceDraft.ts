import { useCallback, useMemo, useRef, useState } from "react";
import { emptyFace, isValidWidthIn, isValidRackUnits, type Face } from "@/domain/faceplate";

export interface DeviceDraft {
  name: string;
  brandId: string | null;
  deviceTypeId: string;
  rackUnits: number;
  widthIn: number;
  rackMounted: boolean;
  activeSide: "front" | "back";
  frontFace: Face;
  backFace: Face;
}

export type DraftErrors = {
  name?: string;
  deviceTypeId?: string;
  widthIn?: string;
  rackUnits?: string;
};

export function emptyDraft(): DeviceDraft {
  return {
    name: "", brandId: null, deviceTypeId: "",
    rackUnits: 1, widthIn: 17.5, rackMounted: true,
    activeSide: "front", frontFace: emptyFace(), backFace: emptyFace(),
  };
}

function computeErrors(d: DeviceDraft): DraftErrors {
  const e: DraftErrors = {};
  if (!d.name.trim()) e.name = "Name is required";
  if (!d.deviceTypeId) e.deviceTypeId = "Device type is required";
  if (!isValidWidthIn(d.widthIn)) e.widthIn = "Width must be greater than 0";
  if (!isValidRackUnits(d.rackUnits)) e.rackUnits = "Rack units must be at least 1";
  return e;
}

export function useDeviceDraft(initial?: Partial<DeviceDraft>) {
  const [draft, setDraft] = useState<DeviceDraft>(() => ({ ...emptyDraft(), ...initial }));
  // Snapshot of the draft as first opened — used to warn before discarding unsaved work.
  const initialRef = useRef<DeviceDraft | null>(null);
  if (initialRef.current === null) initialRef.current = { ...emptyDraft(), ...initial };

  const setField = useCallback(
    <K extends keyof DeviceDraft>(key: K, value: DeviceDraft[K]) => {
      setDraft((d) => ({ ...d, [key]: value }));
    },
    [],
  );

  const setActiveSide = useCallback((side: "front" | "back") => {
    setDraft((d) => ({ ...d, activeSide: side }));
  }, []);

  // Accepts a Face value or an updater `(prev) => Face`. The updater form is
  // essential when a single event fires several mutations in one tick (e.g. a
  // chevron drag adding N columns) — a value computed from the render-closure
  // `activeFace` would be stale across those calls, whereas the updater sees the
  // freshest active face each time.
  const setActiveFace = useCallback((faceOrFn: Face | ((prev: Face) => Face)) => {
    setDraft((d) => {
      const prev = d.activeSide === "front" ? d.frontFace : d.backFace;
      const next = typeof faceOrFn === "function" ? (faceOrFn as (p: Face) => Face)(prev) : faceOrFn;
      return d.activeSide === "front" ? { ...d, frontFace: next } : { ...d, backFace: next };
    });
  }, []);

  const activeFace = draft.activeSide === "front" ? draft.frontFace : draft.backFace;
  const errors = useMemo(() => computeErrors(draft), [draft]);
  const isValid = Object.keys(errors).length === 0;

  // Has the user made any real change since opening? `activeSide` is just which face is on
  // screen (not saved content), so it's ignored — flipping front/back isn't "unsaved work".
  const isDirty = useMemo(() => {
    const strip = (d: DeviceDraft) => ({ ...d, activeSide: "front" as const });
    return JSON.stringify(strip(draft)) !== JSON.stringify(strip(initialRef.current!));
  }, [draft]);

  return { draft, activeFace, setField, setActiveSide, setActiveFace, errors, isValid, isDirty };
}
