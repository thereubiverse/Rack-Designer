import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, act } from "@testing-library/react";
import { PlanUploadZone } from "./PlanUploadZone";
import { uploadFloorPlanAction } from "./actions";
import { convertImageFile, convertPdfPage, getPdfPageCount } from "./planUpload";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));
vi.mock("./actions", () => ({
  uploadFloorPlanAction: vi.fn(async () => ({ ok: true })),
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
});
