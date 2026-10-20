import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useOAuthLoginFlow } from "./use-oauth-login-flow";

// The web package has no DOM renderer, so this file drives the real hook through a minimal
// hook runtime: state slots persist across renders, setState re-runs the hook, and mount
// effects run once with their cleanup on unmount.
const runtime = vi.hoisted(() => {
  const state = {
    slots: [] as Array<{ value: unknown }>,
    index: 0,
    cleanups: [] as Array<() => void>,
    pendingEffects: [] as Array<() => unknown>,
    render: () => {},
  };
  return state;
});

vi.mock("react", () => {
  const slot = (init: () => unknown) => {
    const i = runtime.index++;
    let entry = runtime.slots[i];
    if (!entry) {
      entry = { value: init() };
      runtime.slots[i] = entry;
    }
    return entry;
  };
  return {
    useState: (initial: unknown) => {
      const entry = slot(() => (typeof initial === "function" ? initial() : initial));
      const setState = (next: unknown) => {
        entry.value = typeof next === "function" ? next(entry.value) : next;
        runtime.render();
      };
      return [entry.value, setState];
    },
    useRef: (initial: unknown) => slot(() => ({ current: initial })).value,
    useEffect: (effect: () => unknown) => {
      const i = runtime.index++;
      if (!runtime.slots[i]) {
        runtime.slots[i] = { value: true };
        runtime.pendingEffects.push(effect);
      }
    },
  };
});

const svc = vi.hoisted(() => ({
  startGrok: vi.fn(),
  complete: vi.fn(),
  completeReset: vi.fn(),
  startDevice: vi.fn(),
  pollDevice: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: svc.invalidate }),
}));

vi.mock("@/services/services.generated", () => ({
  QgridService: {
    useOauthStartMutation: () => ({ mutateAsync: vi.fn() }),
    useOauthStartOpenAIMutation: () => ({ mutateAsync: vi.fn() }),
    useOauthStartGrokMutation: () => ({ mutateAsync: svc.startGrok }),
    useOauthCompleteMutation: () => ({ mutateAsync: svc.complete, reset: svc.completeReset }),
    oauthStartGrokDevice: svc.startDevice,
    oauthPollGrokDevice: svc.pollDevice,
  },
  TokenService: { getTokens: vi.fn() },
}));

type Flow = ReturnType<typeof useOAuthLoginFlow>;

function renderLoginFlow() {
  runtime.slots = [];
  runtime.cleanups = [];
  runtime.pendingEffects = [];
  const view: { current: Flow } = { current: renderOnce() };
  runtime.render = () => {
    view.current = renderOnce();
  };
  for (const effect of runtime.pendingEffects.splice(0)) {
    const cleanup = effect();
    if (typeof cleanup === "function") runtime.cleanups.push(() => cleanup());
  }
  return {
    view,
    unmount: () => {
      for (const cleanup of runtime.cleanups.splice(0)) cleanup();
    },
  };
}

function renderOnce(): Flow {
  runtime.index = 0;
  return useOAuthLoginFlow();
}

const popup = { location: { href: "about:blank" }, close: vi.fn() };
const openWindow = vi.fn(() => popup);

const DEVICE_START = {
  deviceCode: "device-code",
  userCode: "ABCD-EFGH",
  verificationUri: "https://accounts.x.ai/device",
  verificationUriComplete: "https://accounts.x.ai/device?user_code=ABCD-EFGH",
  expiresIn: 600,
  interval: 5,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  for (const fn of Object.values(svc)) fn.mockReset();
  svc.invalidate.mockResolvedValue(undefined);
  popup.location.href = "about:blank";
  popup.close.mockReset();
  openWindow.mockClear();
  vi.stubGlobal("window", {
    open: openWindow,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useOAuthLoginFlow — Grok browser flow", () => {
  it("starts with oauthStartGrok, moves to the paste step, and completes with the pasted URL", async () => {
    svc.startGrok.mockResolvedValue({
      authUrl: "https://auth.x.ai/oauth2/authorize?state=s",
      mode: "code",
    });
    svc.complete.mockResolvedValue({ added: true, name: "grok-main" });
    const { view } = renderLoginFlow();

    await view.current.start("grok", "  grok-main ");

    expect(openWindow).toHaveBeenCalledWith("about:blank", "_blank");
    expect(svc.startGrok).toHaveBeenCalledWith({ name: "grok-main" });
    expect(popup.location.href).toBe("https://auth.x.ai/oauth2/authorize?state=s");
    expect(view.current.codeEntryProvider).toBe("grok");
    expect(view.current.loadingProvider).toBeNull();

    const pasted = "http://127.0.0.1:56121/callback?code=abc&state=s";
    await expect(view.current.submitCode(` ${pasted} `)).resolves.toBe(true);
    expect(svc.complete).toHaveBeenCalledWith({ pastedCode: pasted });
    expect(svc.invalidate).toHaveBeenCalled();
  });

  it("refuses a non-https login URL and stays on the provider step", async () => {
    svc.startGrok.mockResolvedValue({ authUrl: "javascript:alert(1)", mode: "code" });
    const { view } = renderLoginFlow();

    await view.current.start("grok", "grok-main");

    expect(popup.close).toHaveBeenCalled();
    expect(popup.location.href).toBe("about:blank");
    expect(view.current.codeEntryProvider).toBeNull();
    expect(view.current.loadingProvider).toBeNull();
  });
});

describe("useOAuthLoginFlow — Grok device flow", () => {
  it("shows the user code, polls at the server interval, backs off on slow_down, and finishes on added", async () => {
    svc.startDevice.mockResolvedValue(DEVICE_START);
    svc.pollDevice
      .mockResolvedValueOnce({ status: "pending", intervalSec: 5 })
      .mockResolvedValueOnce({ status: "slow_down", intervalSec: 10 })
      .mockResolvedValueOnce({ status: "added", name: "grok-main" });
    const onAdded = vi.fn();
    const { view } = renderLoginFlow();

    await view.current.startDevice("grok-main", onAdded);

    expect(svc.startDevice).toHaveBeenCalledWith("grok-main");
    expect(view.current.deviceFlow).toEqual({
      status: "waiting",
      userCode: "ABCD-EFGH",
      verificationUri: "https://accounts.x.ai/device",
      verificationUriComplete: "https://accounts.x.ai/device?user_code=ABCD-EFGH",
      expiresAt: Date.now() + 600_000,
      slowDown: false,
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(svc.pollDevice).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(svc.pollDevice).toHaveBeenCalledTimes(1);
    expect(svc.pollDevice).toHaveBeenCalledWith("device-code");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(svc.pollDevice).toHaveBeenCalledTimes(2);
    expect(view.current.deviceFlow).toMatchObject({ status: "waiting", slowDown: true });

    // slow_down raised the interval to 10 s.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(svc.pollDevice).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(svc.pollDevice).toHaveBeenCalledTimes(3);

    expect(view.current.deviceFlow).toEqual({ status: "added", name: "grok-main" });
    expect(svc.invalidate).toHaveBeenCalled();
    expect(onAdded).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(svc.pollDevice).toHaveBeenCalledTimes(3);
  });

  it("adds 5 s on slow_down when the server omits intervalSec", async () => {
    svc.startDevice.mockResolvedValue(DEVICE_START);
    svc.pollDevice
      .mockResolvedValueOnce({ status: "slow_down" })
      .mockResolvedValue({ status: "pending" });
    const { view } = renderLoginFlow();

    await view.current.startDevice("grok-main");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(svc.pollDevice).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(svc.pollDevice).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(svc.pollDevice).toHaveBeenCalledTimes(2);
  });

  it("reports expiry once expiresIn elapses without approval", async () => {
    svc.startDevice.mockResolvedValue({ ...DEVICE_START, expiresIn: 12 });
    svc.pollDevice.mockResolvedValue({ status: "pending" });
    const { view } = renderLoginFlow();

    await view.current.startDevice("grok-main");
    await vi.advanceTimersByTimeAsync(12_000);

    expect(svc.pollDevice).toHaveBeenCalledTimes(2);
    expect(view.current.deviceFlow).toEqual({ status: "expired" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(svc.pollDevice).toHaveBeenCalledTimes(2);
  });

  it("tolerates a transient poll failure but stops after three consecutive failures", async () => {
    svc.startDevice.mockResolvedValue(DEVICE_START);
    svc.pollDevice
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ status: "pending" })
      .mockRejectedValue(new Error("Grok login failed: access denied"));
    const { view } = renderLoginFlow();

    await view.current.startDevice("grok-main");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(view.current.deviceFlow).toMatchObject({ status: "waiting" });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(svc.pollDevice).toHaveBeenCalledTimes(5);
    expect(view.current.deviceFlow).toEqual({
      status: "error",
      message: "Grok login failed: access denied",
    });
  });

  it("shows the start error without polling", async () => {
    svc.startDevice.mockRejectedValue(new Error("Grok login failed: HTTP 503"));
    const { view } = renderLoginFlow();

    await view.current.startDevice("grok-main");

    expect(view.current.deviceFlow).toEqual({
      status: "error",
      message: "Grok login failed: HTTP 503",
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(svc.pollDevice).not.toHaveBeenCalled();
  });

  it("stops polling on unmount and on reset", async () => {
    svc.startDevice.mockResolvedValue(DEVICE_START);
    svc.pollDevice.mockResolvedValue({ status: "pending" });

    const first = renderLoginFlow();
    await first.view.current.startDevice("grok-main");
    first.unmount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(svc.pollDevice).not.toHaveBeenCalled();

    const second = renderLoginFlow();
    await second.view.current.startDevice("grok-main");
    second.view.current.reset();
    expect(second.view.current.deviceFlow).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(svc.pollDevice).not.toHaveBeenCalled();
  });

  it("does not show an http verification link", async () => {
    svc.startDevice.mockResolvedValue({
      ...DEVICE_START,
      verificationUri: "http://accounts.x.ai/device",
    });
    const { view } = renderLoginFlow();

    await view.current.startDevice("grok-main");

    expect(view.current.deviceFlow).toEqual({
      status: "error",
      message: "Grok verification URL is not https",
    });
  });
});
