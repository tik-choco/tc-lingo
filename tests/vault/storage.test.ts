import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createNode: vi.fn(),
  storageAdd: vi.fn(),
  storageGet: vi.fn(),
}));

vi.mock("../../src/lib/network", () => ({ createAppNode: mocks.createNode }));
vi.mock("@tik-choco/mistlib", () => ({ storage_add: mocks.storageAdd, storage_get: mocks.storageGet }));

describe("storage initialization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("shares initialization and waits before accessing storage", async () => {
    let ready!: () => void;
    const init = vi.fn(() => new Promise<void>((resolve) => { ready = resolve; }));
    const leaveRoom = vi.fn();
    mocks.createNode.mockReturnValue({ init, leaveRoom });
    const bytes = new Uint8Array([1, 2]);
    mocks.storageAdd.mockResolvedValue("cid");
    mocks.storageGet.mockResolvedValue(bytes);
    const { storageAdd, storageGet } = await import("../../src/lib/mistStorage");

    const adding = storageAdd("entry", bytes);
    const getting = storageGet("cid");
    expect(mocks.createNode).toHaveBeenCalledOnce();
    expect(mocks.storageAdd).not.toHaveBeenCalled();
    expect(mocks.storageGet).not.toHaveBeenCalled();
    ready();
    await expect(adding).resolves.toBe("cid");
    await expect(getting).resolves.toEqual(bytes);
    expect(leaveRoom).toHaveBeenCalledOnce();
    await storageGet("cid");
    expect(init).toHaveBeenCalledOnce();
  });

  it("retries initialization after a failure", async () => {
    const leaveRoom = vi.fn();
    mocks.createNode
      .mockReturnValueOnce({ init: vi.fn().mockRejectedValue(new Error("offline")), leaveRoom })
      .mockReturnValueOnce({ init: vi.fn().mockResolvedValue(undefined), leaveRoom });
    mocks.storageGet.mockResolvedValue(new Uint8Array([3]));
    const { storageGet } = await import("../../src/lib/mistStorage");

    await expect(storageGet("cid")).rejects.toThrow("offline");
    expect(mocks.storageGet).not.toHaveBeenCalled();
    await expect(storageGet("cid")).resolves.toEqual(new Uint8Array([3]));
    expect(mocks.createNode).toHaveBeenCalledTimes(2);
    expect(leaveRoom).toHaveBeenCalledOnce();
  });
});
