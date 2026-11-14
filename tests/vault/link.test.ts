import { afterEach, describe, expect, it, vi } from "vitest";
import { takeVaultLink } from "../../src/lib/vault/link";

function locationAt(href: string) {
  const location = { href };
  const replaceState = vi.fn((_state: unknown, _title: string, next: string) => { location.href = next; });
  vi.stubGlobal("window", { location, history: { state: { tab: "settings" }, replaceState } });
  return { location, replaceState };
}

afterEach(() => vi.unstubAllGlobals());

describe("device links", () => {
  it("removes and returns a valid code without changing the path or query", () => {
    const code = "tcv1-aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { location, replaceState } = locationAt(`https://example.test/app?view=1#tc-vault=${code}`);
    expect(takeVaultLink()).toBe(code);
    expect(location.href).toBe("https://example.test/app?view=1");
    expect(replaceState).toHaveBeenCalledOnce();
  });

  it("removes an invalid code and leaves normal routes untouched", () => {
    const invalid = locationAt("https://example.test/app#tc-vault=invalid");
    expect(takeVaultLink()).toBeNull();
    expect(invalid.location.href).toBe("https://example.test/app");

    const route = locationAt("https://example.test/app#/sync/example-room");
    expect(takeVaultLink()).toBeNull();
    expect(route.location.href).toBe("https://example.test/app#/sync/example-room");
    expect(route.replaceState).not.toHaveBeenCalled();
  });

  it("tolerates an unavailable history API", () => {
    locationAt("https://example.test/app#tc-vault=tcv1-aaaaaaaaaaaaaaaaaaaaaaaaaa");
    vi.spyOn(window.history, "replaceState").mockImplementation(() => { throw new Error("unavailable"); });
    expect(takeVaultLink()).toBeNull();
  });
});
