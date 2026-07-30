import { beforeEach, describe, expect, it, vi } from "vitest";

const reactDomMocks = vi.hoisted(() => ({
  createRoot: vi.fn(),
  render: vi.fn(),
}));

vi.mock("react-dom/client", () => ({
  default: {
    createRoot: reactDomMocks.createRoot,
  },
}));

vi.mock("./App", () => ({
  App: () => <div>Mock control room</div>,
}));

describe("application bootstrap", () => {
  beforeEach(() => {
    vi.resetModules();
    reactDomMocks.createRoot.mockReset();
    reactDomMocks.render.mockReset();
    reactDomMocks.createRoot.mockReturnValue({
      render: reactDomMocks.render,
      unmount: vi.fn(),
    });
    document.body.replaceChildren();
  });

  it("fails explicitly when the root mount is missing", async () => {
    await expect(import("./main")).rejects.toThrow("Missing #root mount element.");
    expect(reactDomMocks.createRoot).not.toHaveBeenCalled();
  });

  it("mounts the application into the declared root", async () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);

    await import("./main");

    expect(reactDomMocks.createRoot).toHaveBeenCalledWith(root);
    expect(reactDomMocks.render).toHaveBeenCalledOnce();
  });
});
