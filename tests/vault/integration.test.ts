import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createVault: vi.fn(),
  createTransport: vi.fn(),
  createAdapter: vi.fn(),
  createNode: vi.fn(),
  storageAdd: vi.fn(),
  storageGet: vi.fn(),
}));

vi.mock("@tik-choco/mistvault", () => ({
  createVault: mocks.createVault,
  createMistVaultTransport: mocks.createTransport,
}));
vi.mock("../../src/lib/vault/adapter", () => ({ createVaultAdapter: mocks.createAdapter }));
vi.mock("../../src/lib/network", () => ({ createAppNode: mocks.createNode }));
vi.mock("../../src/lib/mistStorage", () => ({ storageAdd: mocks.storageAdd, storageGet: mocks.storageGet }));

describe("vault integration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("creates one adapter and defers transport and fresh node handles", async () => {
    const adapter = { app: "tc-lingo" };
    const controller = {};
    const transport = {};
    mocks.createAdapter.mockReturnValue(adapter);
    mocks.createVault.mockReturnValue(controller);
    mocks.createTransport.mockReturnValue(transport);
    mocks.createNode.mockImplementation(() => ({}));

    const { vault } = await import("../../src/lib/vault/index");
    expect(vault).toBe(controller);
    expect(mocks.createAdapter).toHaveBeenCalledOnce();
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.createNode).not.toHaveBeenCalled();

    const options = mocks.createVault.mock.calls[0][0];
    expect(options.adapter).toBe(adapter);
    expect(options.transport()).toBe(transport);
    const transportOptions = mocks.createTransport.mock.calls[0][0];
    expect(transportOptions.storageAdd).toBe(mocks.storageAdd);
    expect(transportOptions.storageGet).toBe(mocks.storageGet);
    expect(transportOptions.createNode()).not.toBe(transportOptions.createNode());
    expect(mocks.createNode).toHaveBeenCalledTimes(2);
  });
});
