import { useCallback, useMemo, useState } from "react";
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
    rackUnits: 1, widthIn: 19, rackMounted: true,
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

  const setField = useCallback(
    <K extends keyof DeviceDraft>(key: K, value: DeviceDraft[K]) => {
      setDraft((d) => ({ ...d, [key]: value }));
    },
    [],
  );

  const setActiveSide = useCallback((side: "front" | "back") => {
    setDraft((d) => ({ ...d, activeSide: side }));
  }, []);

  const setActiveFace = useCallback((face: Face) => {
    setDraft((d) =>
      d.activeSide === "front" ? { ...d, frontFace: face } : { ...d, backFace: face },
    );
  }, []);

  const activeFace = draft.activeSide === "front" ? draft.frontFace : draft.backFace;
  const errors = useMemo(() => computeErrors(draft), [draft]);
  const isValid = Object.keys(errors).length === 0;

  return { draft, activeFace, setField, setActiveSide, setActiveFace, errors, isValid };
}
