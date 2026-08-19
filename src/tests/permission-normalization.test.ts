import { describe, expect, it } from "vitest";
import { normalizeDurablePermissionChangeSet } from "../permissions/normalization.js";

describe("durable permission normalization safety", () => {
  it("fails closed when validation reads a throwing update accessor", () => {
    const update = Object.defineProperty({}, "destination", {
      get() {
        throw new Error("provider accessor failed");
      },
    });

    expect(normalizeDurablePermissionChangeSet([update])).toBeUndefined();
  });

  it("fails closed when validation reads a throwing suggestions proxy", () => {
    const suggestions = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") throw new Error("provider proxy failed");
        return Reflect.get(target, property, receiver);
      },
    });

    expect(normalizeDurablePermissionChangeSet(suggestions)).toBeUndefined();
  });
});
