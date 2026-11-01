import { describe, expect, it, vi } from "vitest";
import { registerSessionOpenHook, type SessionOpenHandler } from "../server/compatibility";

describe("Paseo lifecycle capability adapter", () => {
  const handler: SessionOpenHandler = async () => undefined;
  it("uses agent.open.before when addHook exists, without double-registering", () => {
    const remove = vi.fn(),
      host = { addHook: vi.fn(() => remove), before: vi.fn(() => remove) };
    expect(registerSessionOpenHook(host, handler)).toBe(remove);
    expect(host.addHook).toHaveBeenCalledExactlyOnceWith("agent.open.before", handler);
    expect(host.before).not.toHaveBeenCalled();
  });
  it("keeps the legacy session_open hook on older 0.14 hosts", () => {
    const remove = vi.fn(),
      host = { before: vi.fn(() => remove) };
    expect(registerSessionOpenHook(host, handler)).toBe(remove);
    expect(host.before).toHaveBeenCalledExactlyOnceWith("agent.session_open", handler);
  });
  it("preserves host binding and the exact teardown function", () => {
    const remove = vi.fn(),
      host = {
        before: vi.fn(),
        addHook(_name: "agent.open.before", _handler: SessionOpenHandler) {
          expect(this).toBe(host);
          return remove;
        },
      };
    registerSessionOpenHook(host, handler)();
    expect(remove).toHaveBeenCalledOnce();
  });
  it("does not silently register a legacy hook if the new host rejects registration", () => {
    const host = {
      addHook: vi.fn(() => {
        throw new Error("host rejected hook");
      }),
      before: vi.fn(),
    };
    expect(() => registerSessionOpenHook(host, handler)).toThrow("host rejected hook");
    expect(host.before).not.toHaveBeenCalled();
  });
});
