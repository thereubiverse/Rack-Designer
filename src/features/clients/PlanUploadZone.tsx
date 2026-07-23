"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { uploadFloorPlanAction } from "./actions";
import { convertImageFile, convertPdfPage, getPdfPageCount } from "./planUpload";

const ACCEPT = "image/png,image/jpeg,image/webp,application/pdf";
const MAX_BYTES = 15 * 1024 * 1024;

const zone = "rounded-2xl border-2 border-dashed border-neutral-300 bg-neutral-50 px-6 py-10 text-center transition-colors hover:border-blue-400 hover:bg-blue-50/40";
const input = "h-9 rounded-lg border border-neutral-200 px-3 text-sm focus:border-neutral-400 focus:outline-none";

function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

/** No plan: a full dropzone card. Plan already exists: a compact "Replace plan" affordance.
 *  Both share the same pipeline: pick a file -> (image: downscale+re-encode | PDF: pick a page,
 *  then rasterise it) -> upload the resulting PNG blob via `uploadFloorPlanAction`. The 15MB
 *  check runs on the raw selected file, BEFORE any (potentially slow) client-side conversion. */
export function PlanUploadZone({ floorId, hasPlan }: { floorId: string; hasPlan: boolean }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [error, setError] = useState<string | null>(null);
  const [tooBig, setTooBig] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Set only while a multi-page PDF awaits a page choice from the picker.
  const [pendingPdf, setPendingPdf] = useState<{ file: File; pageCount: number } | null>(null);

  function resetInput() {
    if (inputRef.current) inputRef.current.value = "";
  }

  async function uploadBlob(blob: Blob, source: "image" | "pdf") {
    const formData = new FormData();
    formData.set("floorId", floorId);
    formData.set("source", source);
    formData.set("file", blob, "plan.png");

    const res = await uploadFloorPlanAction(formData);
    if (!res.ok) {
      setError(res.error ?? "Upload failed");
      setBusy(false);
      return;
    }

    setNotice(hasPlan ? "Placements kept — check them against the new plan." : null);
    setBusy(false);
    setPendingPdf(null);
    router.refresh();
  }

  async function handleFile(file: File) {
    setError(null);
    setTooBig(false);
    setNotice(null);
    setPendingPdf(null);

    if (file.size > MAX_BYTES) {
      setTooBig(true);
      resetInput();
      return;
    }

    setBusy(true);
    try {
      if (isPdfFile(file)) {
        const pageCount = await getPdfPageCount(file);
        if (pageCount <= 1) {
          const { blob } = await convertPdfPage(file, 0);
          await uploadBlob(blob, "pdf");
        } else {
          setPendingPdf({ file, pageCount });
          setBusy(false);
        }
      } else {
        const { blob } = await convertImageFile(file);
        await uploadBlob(blob, "image");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Conversion failed");
      setBusy(false);
    } finally {
      resetInput();
    }
  }

  async function handlePageChosen(pageIndex: number) {
    if (!pendingPdf) return;
    const { file } = pendingPdf;
    setBusy(true);
    try {
      const { blob } = await convertPdfPage(file, pageIndex);
      await uploadBlob(blob, "pdf");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Conversion failed");
      setBusy(false);
      setPendingPdf(null);
    }
  }

  function onInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
  }

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept={ACCEPT}
      data-testid="plan-file-input"
      className="sr-only"
      onChange={onInputChange}
    />
  );

  const messages = (
    <>
      {tooBig && (
        <p data-testid="plan-too-big" className="text-sm font-semibold text-red-600">
          File is too large (max 15MB)
        </p>
      )}
      {error && (
        <p data-testid="plan-upload-error" className="text-sm font-semibold text-red-600">
          {error}
        </p>
      )}
      {notice && <p className="text-sm font-medium text-blue-700">{notice}</p>}
    </>
  );

  const pagePicker = pendingPdf && (
    <label className="block text-sm font-semibold text-neutral-700">
      Choose a page
      <select
        data-testid="pdf-page-picker"
        className={`${input} mt-1 w-full`}
        defaultValue=""
        disabled={busy}
        onChange={(e) => {
          const value = e.target.value;
          if (!value) return;
          void handlePageChosen(Number(value) - 1);
        }}
      >
        <option value="" disabled>
          Choose a page
        </option>
        {Array.from({ length: pendingPdf.pageCount }, (_, i) => (
          <option key={i} value={i + 1}>
            Page {i + 1}
          </option>
        ))}
      </select>
    </label>
  );

  if (!hasPlan) {
    return (
      <div className="space-y-3">
        <div
          data-testid="plan-dropzone"
          onDrop={onDrop}
          onDragOver={onDragOver}
          className={zone}
        >
          <label className="cursor-pointer">
            <p className="text-sm font-semibold text-neutral-700">
              Drop a floor plan here, or <span className="text-blue-600 underline">browse</span>
            </p>
            <p className="mt-1 text-xs text-neutral-500">PNG, JPEG, WebP, or PDF — up to 15MB</p>
            {fileInput}
          </label>
        </div>
        {pagePicker}
        {messages}
      </div>
    );
  }

  return (
    <div data-testid="plan-replace" className="space-y-3">
      <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-neutral-200 px-4 text-sm font-semibold text-neutral-700 hover:bg-neutral-50">
        Replace plan
        {fileInput}
      </label>
      {pagePicker}
      {messages}
    </div>
  );
}
