import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, act } from "@testing-library/react";
import { PlanUploadZone } from "./PlanUploadZone";
import { uploadFloorPlanAction } from "./actions";
import { extractPlanGeometryAction } from "./planExtractActions";
import { convertImageFile, convertPdfPage, getPdfPageCount } from "./planUpload";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));
vi.mock("./actions", () => ({
  uploadFloorPlanAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("./planExtractActions", () => ({
  extractPlanGeometryAction: vi.fn(async () => ({ ok: true, walls: 0, labels: 0 })),
}));
// Conversion is entirely mocked here: jsdom renders neither PDFs nor canvases, so
// PlanUploadZone.test.tsx only proves the component wires files -> conversion fns -> the action
// correctly. planUpload.ts's own byte-level behaviour has no automated coverage in this slice
// (browser-only APIs: createImageBitmap, canvas, pdfjs-dist) — see the task report.
vi.mock("./planUpload", () => ({
  convertImageFile: vi.fn(),
  convertPdfPage: vi.fn(),
  getPdfPageCount: vi.fn(),
}));

const IMAGE_BLOB = new Blob(["fake-converted-png"], { type: "image/png" });
const PDF_PAGE_BLOB = new Blob(["fake-rendered-pdf-page"], { type: "image/png" });

function makeImageFile(name = "plan.png") {
  return new File(["fake-source-bytes"], name, { type: "image/png" });
}

function makePdfFile(name = "plan.pdf") {
  return new File(["fake-source-bytes"], name, { type: "application/pdf" });
}

function selectFile(file: File) {
  const input = screen.getByTestId("plan-file-input") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(uploadFloorPlanAction).mockResolvedValue({ ok: true });
  vi.mocked(convertImageFile).mockResolvedValue({ blob: IMAGE_BLOB, source: "image" });
  vi.mocked(convertPdfPage).mockResolvedValue({ blob: PDF_PAGE_BLOB, source: "pdf" });
  vi.mocked(getPdfPageCount).mockResolvedValue(1);
  vi.mocked(extractPlanGeometryAction).mockResolvedValue({ ok: true, walls: 0, labels: 0 });
});

describe("PlanUploadZone", () => {
  it("renders a full dropzone card accepting the right file types when there's no plan yet", () => {
    render(<PlanUploadZone floorId="floor-1" hasPlan={false} />);
    expect(screen.getByTestId("plan-dropzone")).toBeInTheDocument();
    const input = screen.getByTestId("plan-file-input") as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.accept).toBe("image/png,image/jpeg,image/webp,application/pdf");
  });

  it("renders a compact 'Replace plan' affordance (not the full dropzone) when a plan already exists", () => {
    render(<PlanUploadZone floorId="floor-1" hasPlan />);
    expect(screen.queryByTestId("plan-dropzone")).toBeNull();
    expect(screen.getByText("Replace plan")).toBeInTheDocument();
    expect(screen.getByTestId("plan-file-input")).toBeInTheDocument();
  });

  it("converts an image file and uploads it with this floor's id and source 'image'", async () => {
    render(<PlanUploadZone floorId="floor-9" hasPlan={false} />);
    const file = makeImageFile();

    await act(async () => {
      selectFile(file);
    });

    expect(convertImageFile).toHaveBeenCalledWith(file);
    expect(convertImageFile).toHaveBeenCalledTimes(1);

    expect(uploadFloorPlanAction).toHaveBeenCalledTimes(1);
    const formData = vi.mocked(uploadFloorPlanAction).mock.calls[0][0] as FormData;
    expect(formData.get("floorId")).toBe("floor-9");
    expect(formData.get("source")).toBe("image");
    const uploaded = formData.get("file") as File;
    expect(uploaded.type).toBe("image/png");
    expect(uploaded.size).toBe(IMAGE_BLOB.size);

    expect(refreshMock).toHaveBeenCalled();
  });

  it("converts a single-page PDF's page 0 directly, without showing a page picker", async () => {
    vi.mocked(getPdfPageCount).mockResolvedValue(1);
    render(<PlanUploadZone floorId="floor-1" hasPlan={false} />);
    const file = makePdfFile();

    await act(async () => {
      selectFile(file);
    });

    expect(getPdfPageCount).toHaveBeenCalledWith(file);
    expect(convertPdfPage).toHaveBeenCalledWith(file, 0);
    expect(screen.queryByTestId("pdf-page-picker")).toBeNull();

    expect(uploadFloorPlanAction).toHaveBeenCalledTimes(1);
    const formData = vi.mocked(uploadFloorPlanAction).mock.calls[0][0] as FormData;
    expect(formData.get("source")).toBe("pdf");
    const uploaded = formData.get("file") as File;
    expect(uploaded.type).toBe("image/png");
    expect(uploaded.size).toBe(PDF_PAGE_BLOB.size);

    expect(refreshMock).toHaveBeenCalled();
  });

  it("shows a page picker for a multi-page PDF, and choosing page 3 calls convertPdfPage(file, 2)", async () => {
    vi.mocked(getPdfPageCount).mockResolvedValue(5);
    render(<PlanUploadZone floorId="floor-1" hasPlan={false} />);
    const file = makePdfFile();

    await act(async () => {
      selectFile(file);
    });

    expect(getPdfPageCount).toHaveBeenCalledWith(file);
    expect(convertPdfPage).not.toHaveBeenCalled();
    expect(uploadFloorPlanAction).not.toHaveBeenCalled();

    const picker = screen.getByTestId("pdf-page-picker") as HTMLSelectElement;
    const options = within(picker).getAllByRole("option");
    // 5 page options, plus a leading placeholder ("Choose a page") that isn't itself a page.
    expect(options.length).toBe(6);

    await act(async () => {
      fireEvent.change(picker, { target: { value: "3" } });
    });

    expect(convertPdfPage).toHaveBeenCalledWith(file, 2);
    expect(convertPdfPage).toHaveBeenCalledTimes(1);

    expect(uploadFloorPlanAction).toHaveBeenCalledTimes(1);
    const formData = vi.mocked(uploadFloorPlanAction).mock.calls[0][0] as FormData;
    expect(formData.get("source")).toBe("pdf");
    expect(refreshMock).toHaveBeenCalled();
  });

  it("choosing page 3 of a multi-page PDF sends BOTH the rendered PNG and the original source PDF, with pdfPage '2' (0-based)", async () => {
    vi.mocked(getPdfPageCount).mockResolvedValue(5);
    render(<PlanUploadZone floorId="floor-1" hasPlan={false} />);
    const file = makePdfFile();

    await act(async () => {
      selectFile(file);
    });

    const picker = screen.getByTestId("pdf-page-picker") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(picker, { target: { value: "3" } });
    });

    expect(convertPdfPage).toHaveBeenCalledWith(file, 2);

    expect(uploadFloorPlanAction).toHaveBeenCalledTimes(1);
    const formData = vi.mocked(uploadFloorPlanAction).mock.calls[0][0] as FormData;

    const uploadedPng = formData.get("file") as File;
    expect(uploadedPng).toBeTruthy();
    expect(uploadedPng.size).toBe(PDF_PAGE_BLOB.size);

    // jsdom's FormData.set(name, file, filename) rewraps the File into a new instance with that
    // filename, so it is no longer the same object reference — compare identity via content/name/
    // type instead of `toBe`.
    const uploadedPdf = formData.get("pdf") as File;
    expect(uploadedPdf.name).toBe(file.name);
    expect(uploadedPdf.type).toBe(file.type);
    expect(uploadedPdf.size).toBe(file.size);
    expect(formData.get("pdfPage")).toBe("2");
  });

  it("shows an inline error and keeps the zone usable when the upload action fails", async () => {
    vi.mocked(uploadFloorPlanAction).mockResolvedValueOnce({ ok: false, error: "Boom" });
    render(<PlanUploadZone floorId="floor-1" hasPlan={false} />);

    await act(async () => {
      selectFile(makeImageFile());
    });

    expect(screen.getByText("Boom")).toBeInTheDocument();
    expect(screen.getByTestId("plan-dropzone")).toBeInTheDocument();
    expect(refreshMock).not.toHaveBeenCalled();

    // Zone stays usable: a subsequent, successful selection still goes through.
    await act(async () => {
      selectFile(makeImageFile("plan2.png"));
    });
    expect(uploadFloorPlanAction).toHaveBeenCalledTimes(2);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("shows the placements-kept notice after a successful replace, and does not show it on first upload", async () => {
    const { rerender } = render(<PlanUploadZone floorId="floor-1" hasPlan={false} />);
    await act(async () => {
      selectFile(makeImageFile());
    });
    expect(
      screen.queryByText("Placements kept — check them against the new plan.")
    ).toBeNull();

    rerender(<PlanUploadZone floorId="floor-1" hasPlan />);
    await act(async () => {
      selectFile(makeImageFile("plan2.png"));
    });
    expect(
      screen.getByText("Placements kept — check them against the new plan.")
    ).toBeInTheDocument();
  });

  it("rejects a file over 15MB client-side, with an inline message, before any conversion runs", async () => {
    render(<PlanUploadZone floorId="floor-1" hasPlan={false} />);
    const bigFile = makeImageFile("big.png");
    Object.defineProperty(bigFile, "size", { value: 16 * 1024 * 1024 });

    await act(async () => {
      selectFile(bigFile);
    });

    expect(screen.getByTestId("plan-too-big")).toBeInTheDocument();
    expect(convertImageFile).not.toHaveBeenCalled();
    expect(getPdfPageCount).not.toHaveBeenCalled();
    expect(uploadFloorPlanAction).not.toHaveBeenCalled();
  });

  // Wall geometry is only extractable from a retained SOURCE PDF. Nothing else in the app calls
  // the extraction action, so if the upload flow doesn't fire it, every plan a real user uploads
  // arrives with zero walls and no wall snapping — the feature exists but never runs.
  it("extracts wall geometry after a PDF upload, before refreshing", async () => {
    render(<PlanUploadZone floorId="floor-7" hasPlan={false} />);

    await act(async () => {
      selectFile(makePdfFile());
    });

    expect(extractPlanGeometryAction).toHaveBeenCalledTimes(1);
    expect(extractPlanGeometryAction).toHaveBeenCalledWith("floor-7");
    // Refresh must come AFTER extraction, or the page re-renders before the walls exist and the
    // user sees a plan with no wall snapping until the next navigation.
    const extractOrder = vi.mocked(extractPlanGeometryAction).mock.invocationCallOrder[0];
    expect(refreshMock.mock.invocationCallOrder[0]).toBeGreaterThan(extractOrder);
  });

  it("does NOT attempt extraction after a plain image upload — there is no PDF to extract from", async () => {
    render(<PlanUploadZone floorId="floor-7" hasPlan={false} />);

    await act(async () => {
      selectFile(makeImageFile());
    });

    expect(uploadFloorPlanAction).toHaveBeenCalledTimes(1);
    expect(extractPlanGeometryAction).not.toHaveBeenCalled();
    expect(refreshMock).toHaveBeenCalled();
  });

  it("never lets an extraction failure fail the upload — a plan without geometry is a working plan", async () => {
    // Both shapes of failure: the action rejecting outright (network/server-action transport), and
    // the action reporting a handled error. Neither may surface as an upload error or skip refresh.
    vi.mocked(extractPlanGeometryAction).mockRejectedValueOnce(new Error("network down"));
    render(<PlanUploadZone floorId="floor-7" hasPlan={false} />);

    await act(async () => {
      selectFile(makePdfFile());
    });

    expect(screen.queryByTestId("plan-upload-error")).toBeNull();
    expect(refreshMock).toHaveBeenCalledTimes(1);

    vi.mocked(extractPlanGeometryAction).mockResolvedValueOnce({ ok: false, error: "nope" });
    await act(async () => {
      selectFile(makePdfFile("plan2.pdf"));
    });

    expect(screen.queryByTestId("plan-upload-error")).toBeNull();
    expect(refreshMock).toHaveBeenCalledTimes(2);
  });

  it("extracts after a page is chosen from a multi-page PDF too", async () => {
    vi.mocked(getPdfPageCount).mockResolvedValue(5);
    render(<PlanUploadZone floorId="floor-7" hasPlan={false} />);

    await act(async () => {
      selectFile(makePdfFile());
    });
    expect(extractPlanGeometryAction).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.change(screen.getByTestId("pdf-page-picker"), { target: { value: "3" } });
    });

    expect(extractPlanGeometryAction).toHaveBeenCalledTimes(1);
    expect(extractPlanGeometryAction).toHaveBeenCalledWith("floor-7");
  });
});
