import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("electron")>()),
  session: {
    fromPartition: vi.fn(() => ({
      getUserAgent: vi.fn(() => "Mozilla/5.0 Electron/41.5.0 t3code/1.2.3"),
      setPermissionRequestHandler: vi.fn(),
      setUserAgent: vi.fn(),
    })),
  },
  screen: {
    getAllDisplays: vi.fn(() => [
      {
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      },
    ]),
  },
}));

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { MENU_ACTION_CHANNEL, WINDOW_FULLSCREEN_STATE_CHANNEL } from "../ipc/channels.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopWindow from "./DesktopWindow.ts";
import * as PreviewManager from "../preview/Manager.ts";

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

function makeFakeBrowserWindow() {
  const windowListeners = new Map<string, (...args: readonly unknown[]) => void>();
  const webContentsListeners = new Map<string, (...args: readonly unknown[]) => void>();
  let zoomLevel = 0;
  const webContents = {
    copyImageAt: vi.fn(),
    getURL: vi.fn(() => "t3code-dev://app/"),
    getZoomLevel: vi.fn(() => zoomLevel),
    setZoomLevel: vi.fn((level: number) => {
      zoomLevel = level;
    }),
    isLoadingMainFrame: vi.fn(() => false),
    on: vi.fn((eventName: string, listener: (...args: readonly unknown[]) => void) => {
      webContentsListeners.set(eventName, listener);
    }),
    once: vi.fn(),
    openDevTools: vi.fn(),
    reload: vi.fn(),
    replaceMisspelling: vi.fn(),
    send: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  };

  const window = {
    close: vi.fn(),
    focus: vi.fn(),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 1100, height: 780 })),
    getNormalBounds: vi.fn(() => ({ x: 0, y: 0, width: 1100, height: 780 })),
    isDestroyed: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    loadURL: vi.fn(() => Promise.resolve()),
    maximize: vi.fn(),
    on: vi.fn((eventName: string, listener: (...args: readonly unknown[]) => void) => {
      windowListeners.set(eventName, listener);
    }),
    once: vi.fn((eventName: string, listener: (...args: readonly unknown[]) => void) => {
      windowListeners.set(eventName, listener);
    }),
    restore: vi.fn(),
    setBackgroundColor: vi.fn(),
    setAutoHideCursor: vi.fn(),
    setTitle: vi.fn(),
    setTitleBarOverlay: vi.fn(),
    show: vi.fn(),
    webContents,
  };

  return {
    window: window as unknown as Electron.BrowserWindow,
    getBounds: window.getBounds,
    getNormalBounds: window.getNormalBounds,
    isDestroyed: window.isDestroyed,
    isFullScreen: window.isFullScreen,
    isMaximized: window.isMaximized,
    isMinimized: window.isMinimized,
    loadURL: window.loadURL,
    maximize: window.maximize,
    openDevTools: webContents.openDevTools,
    reload: webContents.reload,
    send: webContents.send,
    setZoomLevel: webContents.setZoomLevel,
    setBackgroundThrottling: webContents.setBackgroundThrottling,
    setAutoHideCursor: window.setAutoHideCursor,
    webContentsListeners,
    windowListeners,
  };
}

const desktopClientSettingsLayer = Layer.mock(DesktopClientSettings.DesktopClientSettings)({
  get: Effect.succeed(Option.none()),
});

const electronAppLayer = Layer.mock(ElectronApp.ElectronApp)({
  quit: Effect.void,
});

const desktopAssetsLayer = Layer.succeed(DesktopAssets.DesktopAssets, {
  iconPaths: Effect.succeed({
    ico: Option.none<string>(),
    icns: Option.none<string>(),
    png: Option.none<string>(),
  }),
  resolveResourcePath: () => Effect.succeed(Option.none<string>()),
} satisfies DesktopAssets.DesktopAssets["Service"]);

const desktopServerExposureLayer = Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
  getState: Effect.die("unexpected getState"),
  backendConfig: Effect.succeed({
    port: 3773,
    bindHost: "127.0.0.1",
    httpBaseUrl: new URL("http://127.0.0.1:3773"),
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  }),
  configureFromSettings: () => Effect.die("unexpected configureFromSettings"),
  setMode: () => Effect.die("unexpected setMode"),
  setTailscaleServeEnabled: () => Effect.die("unexpected setTailscaleServeEnabled"),
  getAdvertisedEndpoints: Effect.die("unexpected getAdvertisedEndpoints"),
} satisfies DesktopServerExposure.DesktopServerExposure["Service"]);

const electronMenuLayer = Layer.succeed(ElectronMenu.ElectronMenu, {
  setApplicationMenu: () => Effect.void,
  popupTemplate: () => Effect.void,
  showContextMenu: () => Effect.succeed(Option.none()),
} satisfies ElectronMenu.ElectronMenu["Service"]);

const electronThemeLayer = Layer.succeed(ElectronTheme.ElectronTheme, {
  shouldUseDarkColors: Effect.succeed(false),
  setSource: () => Effect.void,
  onUpdated: () => Effect.void,
} satisfies ElectronTheme.ElectronTheme["Service"]);

const desktopEnvironmentLayer = DesktopEnvironment.layer(environmentInput).pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      DesktopConfig.layerTest({
        T3CODE_PORT: "3773",
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5733",
      }),
    ),
  ),
);

const desktopWindowBoundsEquivalence = Schema.toEquivalence(
  DesktopAppSettings.DesktopWindowBoundsSchema,
);

function makeDesktopStateLayer(quitting?: Ref.Ref<boolean>) {
  return quitting === undefined
    ? DesktopState.layer
    : Layer.effect(
        DesktopState.DesktopState,
        Effect.map(Ref.make(false), (backendReady) => ({ backendReady, quitting })),
      );
}

function makeTestLayer(input: {
  readonly window: Electron.BrowserWindow;
  /** Returned by `create` after the first window, in order. */
  readonly additionalWindows?: readonly Electron.BrowserWindow[];
  readonly createCount: Ref.Ref<number>;
  readonly mainWindow: Ref.Ref<Option.Option<Electron.BrowserWindow>>;
  readonly createdWindowOptions?: Electron.BrowserWindowConstructorOptions[];
  readonly desktopSettings?: DesktopAppSettings.DesktopSettings;
  readonly mainWindowBoundsUpdates?: DesktopAppSettings.DesktopWindowBounds[];
  readonly mainWindowMaximizedUpdates?: boolean[];
  /** Every value written to the reopen-on-launch set, in order. */
  readonly secondaryWindowUpdates?: (readonly DesktopAppSettings.DesktopSecondaryWindow[])[];
  readonly beforeMainWindowBoundsUpdate?: (
    bounds: DesktopAppSettings.DesktopWindowBounds,
  ) => Effect.Effect<void>;
  readonly openedExternalUrls?: unknown[];
  readonly previewZoomReapplies?: number[];
  /** Flipped by tests that need to tell an app quit from a user closing a window. */
  readonly quittingRef?: Ref.Ref<boolean>;
}) {
  let desktopSettings = input.desktopSettings ?? DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS;
  const desktopAppSettingsLayer = Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
    get: Effect.sync(() => desktopSettings),
    load: Effect.sync(() => desktopSettings),
    setMainWindowBounds: (bounds, isMaximized) =>
      Effect.gen(function* () {
        if (input.beforeMainWindowBoundsUpdate) {
          yield* input.beforeMainWindowBoundsUpdate(bounds);
        }
        const changed =
          desktopSettings.mainWindowBounds === null ||
          !desktopWindowBoundsEquivalence(desktopSettings.mainWindowBounds, bounds) ||
          desktopSettings.mainWindowMaximized !== isMaximized;
        if (changed) {
          desktopSettings = {
            ...desktopSettings,
            mainWindowBounds: bounds,
            mainWindowMaximized: isMaximized,
          };
          input.mainWindowBoundsUpdates?.push(bounds);
          input.mainWindowMaximizedUpdates?.push(isMaximized);
        }
        return { settings: desktopSettings, changed };
      }),
    setSecondaryWindows: (windows) =>
      Effect.sync(() => {
        const current = desktopSettings.secondaryWindows;
        const changed =
          current.length !== windows.length ||
          windows.some((window, index) => {
            const previous = current[index];
            return (
              previous === undefined ||
              previous.url !== window.url ||
              !desktopWindowBoundsEquivalence(previous.bounds, window.bounds)
            );
          });
        if (changed) {
          desktopSettings = { ...desktopSettings, secondaryWindows: windows };
          input.secondaryWindowUpdates?.push(windows);
        }
        return { settings: desktopSettings, changed };
      }),
    setServerExposureMode: () => Effect.die("unexpected server exposure update"),
    setTailscaleServe: () => Effect.die("unexpected Tailscale Serve update"),
    setUpdateChannel: () => Effect.die("unexpected update channel change"),
    setWslBackendEnabled: () => Effect.die("unexpected WSL backend toggle"),
    setWslDistro: () => Effect.die("unexpected WSL distro change"),
    setWslOnly: () => Effect.die("unexpected WSL-only toggle"),
    applyWslWindowsFallback: Effect.die("unexpected WSL Windows fallback"),
    applyWslWindowsFallbackInMemory: Effect.die("unexpected WSL Windows fallback"),
  } satisfies DesktopAppSettings.DesktopAppSettings["Service"]);

  const electronWindowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: (options) =>
      Effect.gen(function* () {
        input.createdWindowOptions?.push(options);
        const index = yield* Ref.getAndUpdate(input.createCount, (count) => count + 1);
        return index === 0 ? input.window : (input.additionalWindows?.[index - 1] ?? input.window);
      }),
    main: Ref.get(input.mainWindow),
    currentMainOrFirst: Ref.get(input.mainWindow),
    focusedMainOrFirst: Ref.get(input.mainWindow),
    setMain: (window) => Ref.set(input.mainWindow, Option.some(window)),
    clearMain: () => Ref.set(input.mainWindow, Option.none()),
    reveal: () => Effect.void,
    sendAll: () => Effect.void,
    destroyAll: Effect.void,
    syncAllAppearance: (sync) => sync(input.window),
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  return DesktopWindow.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        desktopAssetsLayer,
        desktopEnvironmentLayer,
        desktopAppSettingsLayer,
        desktopClientSettingsLayer,
        desktopServerExposureLayer,
        makeDesktopStateLayer(input.quittingRef),
        electronAppLayer,
        electronMenuLayer,
        Layer.succeed(ElectronShell.ElectronShell, {
          openExternal: (url) =>
            Effect.sync(() => {
              input.openedExternalUrls?.push(url);
              return true;
            }),
          copyText: () => Effect.void,
        } satisfies ElectronShell.ElectronShell["Service"]),
        electronThemeLayer,
        electronWindowLayer,
        Layer.mock(PreviewManager.PreviewManager)({
          getBrowserSession: () => Effect.succeed({} as Electron.Session),
          registerWindow: () => Effect.void,
          isBrowserPartition: (partition) => partition.startsWith("persist:t3code-preview-"),
          getBrowserPartition: () => Effect.succeed("persist:t3code-preview-test"),
          reapplyZoom: () =>
            Effect.sync(() => {
              input.previewZoomReapplies?.push(input.window.webContents.getZoomLevel());
            }),
        }),
      ),
    ),
  );
}

// Builds a DesktopWindow over a fake ElectronWindow whose `create` returns the
// given outcomes in order (null => simulated open failure), and whose
// currentMainOrFirst mirrors the real fallback to the first live window (the
// splash, before any main is registered). Reveal targets are recorded so tests
// can assert what activation actually surfaced.
const makeSplashScenario = (createOutcomes: readonly (Electron.BrowserWindow | null)[]) =>
  Effect.gen(function* () {
    const createdWindows = yield* Ref.make<Electron.BrowserWindow[]>([]);
    const createCalls = yield* Ref.make(0);
    const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
    const revealedWindows = yield* Ref.make<Electron.BrowserWindow[]>([]);
    const fallbackWindow = createOutcomes.find(
      (window): window is Electron.BrowserWindow => window !== null,
    );

    const currentMainOrFirst = Effect.gen(function* () {
      const registered = yield* Ref.get(mainWindow);
      if (Option.isSome(registered)) {
        return registered;
      }
      const created = yield* Ref.get(createdWindows);
      return Option.fromNullishOr(created[0] ?? null);
    });

    const electronWindowShape = {
      create: () =>
        Effect.gen(function* () {
          const index = yield* Ref.getAndUpdate(createCalls, (count) => count + 1);
          const outcome = createOutcomes[index] ?? null;
          if (outcome === null) {
            return yield* new ElectronWindow.ElectronWindowCreateError({
              options: {
                title: null,
                width: null,
                height: null,
                minWidth: null,
                minHeight: null,
                show: null,
                modal: null,
                frame: null,
                transparent: null,
                backgroundColor: null,
                webPreferences: {
                  preload: null,
                  partition: null,
                  backgroundThrottling: null,
                  sandbox: null,
                  contextIsolation: null,
                  nodeIntegration: null,
                  webviewTag: null,
                },
              },
              cause: new Error("simulated window-open failure"),
            });
          }
          yield* Ref.update(createdWindows, (windows) => [...windows, outcome]);
          return outcome;
        }),
      main: Ref.get(mainWindow),
      currentMainOrFirst,
      focusedMainOrFirst: currentMainOrFirst,
      setMain: (window) => Ref.set(mainWindow, Option.some(window)),
      clearMain: () => Ref.set(mainWindow, Option.none()),
      reveal: (window) => Ref.update(revealedWindows, (windows) => [...windows, window]),
      sendAll: () => Effect.void,
      destroyAll: Effect.void,
      syncAllAppearance: (sync) => (fallbackWindow ? sync(fallbackWindow) : Effect.void),
    } satisfies ElectronWindow.ElectronWindow["Service"];

    const layer = DesktopWindow.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          desktopAssetsLayer,
          desktopEnvironmentLayer,
          DesktopAppSettings.layerTest(),
          desktopClientSettingsLayer,
          desktopServerExposureLayer,
          DesktopState.layer,
          electronAppLayer,
          electronMenuLayer,
          Layer.succeed(ElectronShell.ElectronShell, {
            openExternal: () => Effect.succeed(true),
            copyText: () => Effect.void,
          } satisfies ElectronShell.ElectronShell["Service"]),
          electronThemeLayer,
          Layer.succeed(ElectronWindow.ElectronWindow, electronWindowShape),
          Layer.mock(PreviewManager.PreviewManager)({
            getBrowserSession: () => Effect.succeed({} as Electron.Session),
            registerWindow: () => Effect.void,
            isBrowserPartition: (partition) => partition.startsWith("persist:t3code-preview-"),
            getBrowserPartition: () => Effect.succeed("persist:t3code-preview-test"),
          }),
        ),
      ),
    );

    return { layer, createCalls, mainWindow, revealedWindows } as const;
  });

describe("DesktopWindow", () => {
  it("restores bounds only when the window fits within a connected display", () => {
    const persistedBounds = { x: 2040, y: 80, width: 1320, height: 880 };
    const displays = [
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 1920, y: 0, width: 2560, height: 1440 },
    ];

    assert.deepEqual(
      DesktopWindow.resolvePersistedWindowBounds(persistedBounds, displays),
      persistedBounds,
    );
    assert.deepEqual(
      DesktopWindow.resolvePersistedWindowBounds(persistedBounds, [displays[0]!]),
      DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE,
    );
  });

  it("cascades a secondary window off the focused one and drops the offset at a display edge", () => {
    const displays = [{ x: 0, y: 0, width: 1920, height: 1080 }];
    const roomToCascade = { x: 100, y: 100, width: 1200, height: 800 };
    const flushAgainstTheEdge = { x: 720, y: 280, width: 1200, height: 800 };
    const offDisplay = { x: 4000, y: 0, width: 1200, height: 800 };

    assert.deepEqual(DesktopWindow.resolveSecondaryWindowBounds(roomToCascade, displays), {
      x: 124,
      y: 124,
      width: 1200,
      height: 800,
    });
    // The cascade would push it off the display, so the new window lands exactly
    // on top of the focused one rather than half off-screen.
    assert.deepEqual(
      DesktopWindow.resolveSecondaryWindowBounds(flushAgainstTheEdge, displays),
      flushAgainstTheEdge,
    );
    assert.deepEqual(
      DesktopWindow.resolveSecondaryWindowBounds(offDisplay, displays),
      DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE,
    );
    assert.deepEqual(
      DesktopWindow.resolveSecondaryWindowBounds(null, displays),
      DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE,
    );
  });

  it.effect("keeps bounds persistence on the main window after a secondary window opens", () =>
    Effect.gen(function* () {
      const mainFake = makeFakeBrowserWindow();
      mainFake.getBounds.mockReturnValue({ x: 100, y: 100, width: 1200, height: 800 });
      const secondaryFake = makeFakeBrowserWindow();
      secondaryFake.getBounds.mockReturnValue({ x: 124, y: 124, width: 1200, height: 800 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const layer = makeTestLayer({
        window: mainFake.window,
        additionalWindows: [secondaryFake.window],
        createCount,
        mainWindow,
        createdWindowOptions,
        mainWindowBoundsUpdates,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        yield* desktopWindow.createSecondary;

        assert.equal(yield* Ref.get(createCount), 2);
        assert.equal(createdWindowOptions[1]?.x, 124);
        assert.equal(createdWindowOptions[1]?.y, 124);
        // Window 1 stays "main": a secondary never re-registers itself.
        assert.deepEqual(yield* Ref.get(mainWindow), Option.some(mainFake.window));
        // A secondary tracks its own bounds for the reopen set, but it never
        // touches the single persisted main-window record and never joins the
        // close-time flush the quit path drains.
        secondaryFake.windowListeners.get("resize")?.();
        yield* TestClock.adjust(500);
        yield* Effect.promise(() => Promise.resolve());
        assert.deepEqual(mainWindowBoundsUpdates, []);
        assert.isUndefined(secondaryFake.windowListeners.get("close"));

        yield* desktopWindow.flushMainWindowBounds;
        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 100, y: 100, width: 1200, height: 800 }]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("drops a window the user closed from the set that reopens on launch", () =>
    Effect.gen(function* () {
      const mainFake = makeFakeBrowserWindow();
      const secondaryFake = makeFakeBrowserWindow();
      secondaryFake.getBounds.mockReturnValue({ x: 124, y: 124, width: 1200, height: 800 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const secondaryWindowUpdates: (readonly DesktopAppSettings.DesktopSecondaryWindow[])[] = [];
      const quittingRef = yield* Ref.make(false);
      const layer = makeTestLayer({
        window: mainFake.window,
        additionalWindows: [secondaryFake.window],
        createCount,
        mainWindow,
        secondaryWindowUpdates,
        quittingRef,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        yield* desktopWindow.createSecondary;
        yield* Effect.promise(() => Promise.resolve());

        // Opening records where the window sits and what it is showing.
        assert.deepEqual(secondaryWindowUpdates, [
          [{ bounds: { x: 124, y: 124, width: 1200, height: 800 }, url: null }],
        ]);

        // Navigating updates the recorded route, debounced like the main
        // window's bounds.
        secondaryFake.webContentsListeners.get("did-navigate-in-page")?.();
        yield* TestClock.adjust(500);
        yield* Effect.promise(() => Promise.resolve());
        assert.deepEqual(secondaryWindowUpdates[1], [
          { bounds: { x: 124, y: 124, width: 1200, height: 800 }, url: "t3code-dev://app/" },
        ]);

        // Closing it while the app keeps running means "not this one again".
        secondaryFake.windowListeners.get("closed")?.();
        yield* Effect.promise(() => Promise.resolve());
        assert.deepEqual(secondaryWindowUpdates.at(-1), []);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("keeps the set that reopens on launch when the app is quitting", () =>
    Effect.gen(function* () {
      const mainFake = makeFakeBrowserWindow();
      const secondaryFake = makeFakeBrowserWindow();
      secondaryFake.getBounds.mockReturnValue({ x: 124, y: 124, width: 1200, height: 800 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const secondaryWindowUpdates: (readonly DesktopAppSettings.DesktopSecondaryWindow[])[] = [];
      const quittingRef = yield* Ref.make(false);
      const layer = makeTestLayer({
        window: mainFake.window,
        additionalWindows: [secondaryFake.window],
        createCount,
        mainWindow,
        secondaryWindowUpdates,
        quittingRef,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        yield* desktopWindow.createSecondary;
        yield* Effect.promise(() => Promise.resolve());
        assert.equal(secondaryWindowUpdates.length, 1);

        // Quit tears every window down, and that set is exactly what should come
        // back next launch.
        yield* Ref.set(quittingRef, true);
        secondaryFake.windowListeners.get("closed")?.();
        yield* Effect.promise(() => Promise.resolve());
        assert.equal(secondaryWindowUpdates.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("reopens saved windows on launch, off-display ones at the default size", () =>
    Effect.gen(function* () {
      const mainFake = makeFakeBrowserWindow();
      const restoredFake = makeFakeBrowserWindow();
      const offDisplayFake = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
      const layer = makeTestLayer({
        window: mainFake.window,
        additionalWindows: [restoredFake.window, offDisplayFake.window],
        createCount,
        mainWindow,
        createdWindowOptions,
        desktopSettings: {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          secondaryWindows: [
            {
              bounds: { x: 120, y: 80, width: 1280, height: 900 },
              url: "t3code-dev://app/#/projects/one",
            },
            // Saved on a monitor that is no longer connected.
            { bounds: { x: 4000, y: 0, width: 1200, height: 800 }, url: "https://evil.example/" },
          ],
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        assert.equal(yield* Ref.get(createCount), 3);
        assert.equal(createdWindowOptions[1]?.x, 120);
        assert.equal(createdWindowOptions[1]?.y, 80);
        assert.equal(createdWindowOptions[1]?.width, 1280);
        // Unreachable bounds fall back to the default size rather than opening
        // the window somewhere the user cannot get to it.
        assert.isUndefined(createdWindowOptions[2]?.x);
        assert.equal(createdWindowOptions[2]?.width, 1100);
        assert.equal(createdWindowOptions[2]?.height, 780);

        // The saved route comes back; a URL that is not ours never gets loaded.
        assert.deepEqual(restoredFake.loadURL.mock.calls, [["t3code-dev://app/#/projects/one"]]);
        assert.deepEqual(offDisplayFake.loadURL.mock.calls, [["t3code-dev://app/"]]);

        // A second readiness report (backend restart) must not double the windows.
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        assert.equal(yield* Ref.get(createCount), 3);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("opens the app's default route when a saved one fails to load", () =>
    Effect.gen(function* () {
      const mainFake = makeFakeBrowserWindow();
      const restoredFake = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({
        window: mainFake.window,
        additionalWindows: [restoredFake.window],
        createCount,
        mainWindow,
        desktopSettings: {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          secondaryWindows: [
            {
              bounds: { x: 120, y: 80, width: 1280, height: 900 },
              url: "t3code-dev://app/#/projects/gone",
            },
          ],
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const didFailLoad = restoredFake.webContentsListeners.get("did-fail-load");
        if (!didFailLoad) {
          return yield* Effect.die("renderer load listeners were not registered");
        }
        didFailLoad({}, -6, "ERR_FILE_NOT_FOUND", "t3code-dev://app/#/projects/gone", true);

        assert.deepEqual(restoredFake.loadURL.mock.calls, [
          ["t3code-dev://app/#/projects/gone"],
          ["t3code-dev://app/"],
        ]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it("loads a saved route back only when it is the app's own origin", () => {
    assert.equal(
      DesktopWindow.resolveRestoredWindowUrl({
        applicationUrl: "t3code://app/",
        savedUrl: "t3code://app/#/projects/one",
      }),
      "t3code://app/#/projects/one",
    );
    assert.equal(
      DesktopWindow.resolveRestoredWindowUrl({
        applicationUrl: "t3code://app/",
        savedUrl: "https://evil.example/steal",
      }),
      "t3code://app/",
    );
    assert.equal(
      DesktopWindow.resolveRestoredWindowUrl({
        applicationUrl: "t3code://app/",
        savedUrl: "not a url",
      }),
      "t3code://app/",
    );
    assert.equal(
      DesktopWindow.resolveRestoredWindowUrl({ applicationUrl: "t3code://app/", savedUrl: null }),
      "t3code://app/",
    );
  });

  it.effect("ignores a new window request made before the backend is ready", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({ window: fakeWindow.window, createCount, mainWindow });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.createSecondary;
        assert.equal(yield* Ref.get(createCount), 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it("recognizes only same-origin renderer navigations", () => {
    assert.isTrue(
      DesktopWindow.isSameOriginRendererNavigation({
        applicationUrl: "t3code://app/",
        navigationUrl: "t3code://app/settings/connections",
      }),
    );
    assert.isFalse(
      DesktopWindow.isSameOriginRendererNavigation({
        applicationUrl: "t3code://app/",
        navigationUrl: "https://accounts.microsoft.com/oauth",
      }),
    );
    assert.isFalse(
      DesktopWindow.isSameOriginRendererNavigation({
        applicationUrl: "t3code://app/",
        navigationUrl: "not a url",
      }),
    );
  });

  it.effect("does not open a development window until the backend is ready", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        createdWindowOptions,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.activate;
        assert.equal(yield* Ref.get(createCount), 0);

        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        assert.equal(yield* Ref.get(createCount), 1);
        assert.equal(createdWindowOptions[0]?.width, 1100);
        assert.equal(createdWindowOptions[0]?.height, 780);
        assert.isUndefined(createdWindowOptions[0]?.x);
        assert.isUndefined(createdWindowOptions[0]?.y);
        assert.isTrue(createdWindowOptions[0]?.disableAutoHideCursor);
        assert.isFalse(createdWindowOptions[0]?.webPreferences?.backgroundThrottling);
        assert.deepEqual(fakeWindow.setAutoHideCursor.mock.calls, [[false]]);
        assert.deepEqual(fakeWindow.loadURL.mock.calls[0], ["t3code-dev://app/"]);
        assert.equal(fakeWindow.openDevTools.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("blocks only repeated Cmd+W input before it reaches the native window menu", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const beforeInput = fakeWindow.webContentsListeners.get("before-input-event");
        if (!beforeInput) {
          return yield* Effect.die("before-input-event listener was not registered");
        }

        let prevented = false;
        const event = { preventDefault: () => (prevented = true) };
        const input = {
          type: "keyDown",
          isAutoRepeat: true,
          key: "W",
          meta: true,
          control: false,
          alt: false,
          shift: false,
        };
        beforeInput(event, input);
        assert.isTrue(prevented);

        prevented = false;
        beforeInput(event, { ...input, isAutoRepeat: false });
        assert.isFalse(prevented);

        prevented = false;
        beforeInput(event, { ...input, meta: false });
        assert.isFalse(prevented);
      }).pipe(Effect.provide(layer));
    }),
  );

  // Chromium hands the main window's zoom level down to embedded preview
  // guests, so every app zoom has to put the preview browser back at its own
  // zoom or zooming the UI drags the previewed page with it.
  it.effect("restores the preview browser's own zoom after zooming the app", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const previewZoomReapplies: number[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        previewZoomReapplies,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        yield* desktopWindow.zoomMain("out");
        yield* desktopWindow.zoomMain("out");
        yield* desktopWindow.zoomMain("in");
        yield* desktopWindow.zoomMain("reset");

        assert.deepEqual(
          fakeWindow.setZoomLevel.mock.calls.map(([level]) => level),
          [-0.5, -1, -0.5, 0],
        );
        // Recorded after the window level moved, so the preview is put back at
        // its own zoom on every step rather than left on the inherited one.
        assert.deepEqual(previewZoomReapplies, [-0.5, -1, -0.5, 0]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("uses the persisted main window bounds when opening the window", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        createdWindowOptions,
        desktopSettings: {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          mainWindowBounds: { x: 120, y: 80, width: 1320, height: 880 },
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        assert.equal(createdWindowOptions[0]?.width, 1320);
        assert.equal(createdWindowOptions[0]?.height, 880);
        assert.equal(createdWindowOptions[0]?.x, 120);
        assert.equal(createdWindowOptions[0]?.y, 80);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("restores the persisted maximized state", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        desktopSettings: {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          mainWindowBounds: { x: 120, y: 80, width: 1320, height: 880 },
          mainWindowMaximized: true,
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        assert.equal(fakeWindow.maximize.mock.calls.length, 0);
        const readyToShow = fakeWindow.windowListeners.get("ready-to-show");
        if (!readyToShow) {
          return yield* Effect.die("window ready-to-show listener was not registered");
        }
        readyToShow();
        assert.equal(fakeWindow.maximize.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  // The window boots hidden with throttling disabled so first paint runs at
  // full speed; the first reveal must hand it back to normal hidden-window
  // throttling or a minimized window stays expensive forever.
  it.effect("re-enables background throttling on first reveal", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        assert.equal(fakeWindow.setBackgroundThrottling.mock.calls.length, 0);
        const readyToShow = fakeWindow.windowListeners.get("ready-to-show");
        if (!readyToShow) {
          return yield* Effect.die("window ready-to-show listener was not registered");
        }
        readyToShow();
        assert.deepEqual(fakeWindow.setBackgroundThrottling.mock.calls, [[true]]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("debounces move and resize bounds updates", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const move = fakeWindow.windowListeners.get("move");
        const resize = fakeWindow.windowListeners.get("resize");
        if (!move || !resize) {
          return yield* Effect.die("window bounds listeners were not registered");
        }

        fakeWindow.getBounds.mockReturnValue({ x: 120, y: 80, width: 1280, height: 840 });
        move();
        yield* TestClock.adjust(250);

        fakeWindow.getBounds.mockReturnValue({ x: 160, y: 100, width: 1360, height: 900 });
        resize();
        yield* TestClock.adjust(499);
        assert.deepEqual(mainWindowBoundsUpdates, []);

        yield* TestClock.adjust(1);
        yield* Effect.promise(() => Promise.resolve());
        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 160, y: 100, width: 1360, height: 900 }]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("persists normal bounds and state for a maximized window", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.isMaximized.mockReturnValue(true);
      fakeWindow.getBounds.mockReturnValue({ x: 0, y: 0, width: 1920, height: 1080 });
      fakeWindow.getNormalBounds.mockReturnValue({ x: 220, y: 140, width: 1380, height: 920 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const mainWindowMaximizedUpdates: boolean[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
        mainWindowMaximizedUpdates,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const close = fakeWindow.windowListeners.get("close");
        if (!close) {
          return yield* Effect.die("window close listener was not registered");
        }
        close();
        yield* Effect.promise(() => Promise.resolve());

        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 220, y: 140, width: 1380, height: 920 }]);
        assert.deepEqual(mainWindowMaximizedUpdates, [true]);
        assert.equal(fakeWindow.getNormalBounds.mock.calls.length, 1);
        assert.equal(fakeWindow.getBounds.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("persists normal bounds and state from the native maximize event", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const mainWindowMaximizedUpdates: boolean[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
        mainWindowMaximizedUpdates,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const maximize = fakeWindow.windowListeners.get("maximize");
        if (!maximize) {
          return yield* Effect.die("window maximize listener was not registered");
        }

        fakeWindow.isMaximized.mockReturnValue(true);
        fakeWindow.getBounds.mockReturnValue({ x: 0, y: 0, width: 1920, height: 1080 });
        fakeWindow.getNormalBounds.mockReturnValue({ x: 220, y: 140, width: 1380, height: 920 });
        maximize();
        yield* TestClock.adjust(500);
        yield* Effect.promise(() => Promise.resolve());

        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 220, y: 140, width: 1380, height: 920 }]);
        assert.deepEqual(mainWindowMaximizedUpdates, [true]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not persist bounds that fail the domain schema", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.getBounds.mockReturnValue({ x: 100.4, y: 80.2, width: 839.4, height: 619.4 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const resize = fakeWindow.windowListeners.get("resize");
        if (!resize) {
          return yield* Effect.die("window resize listener was not registered");
        }
        resize();
        yield* TestClock.adjust(500);
        yield* Effect.promise(() => Promise.resolve());

        assert.deepEqual(mainWindowBoundsUpdates, []);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("preserves unrestorable bounds until the user changes the window", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
        desktopSettings: {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          mainWindowBounds: { x: 2040, y: 80, width: 1320, height: 880 },
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const close = fakeWindow.windowListeners.get("close");
        const move = fakeWindow.windowListeners.get("move");
        if (!close || !move) {
          return yield* Effect.die("window lifecycle listeners were not registered");
        }

        close();
        yield* Effect.promise(() => Promise.resolve());
        assert.deepEqual(mainWindowBoundsUpdates, []);

        fakeWindow.getBounds.mockReturnValue({ x: 80, y: 60, width: 1280, height: 840 });
        move();
        yield* TestClock.adjust(500);
        yield* Effect.promise(() => Promise.resolve());
        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 80, y: 60, width: 1280, height: 840 }]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("flushes normal bounds when fullscreen before the debounce completes", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.getBounds.mockReturnValue({ x: 0, y: 0, width: 1920, height: 1080 });
      fakeWindow.getNormalBounds.mockReturnValue({ x: 200, y: 130, width: 1400, height: 940 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const resize = fakeWindow.windowListeners.get("resize");
        if (!resize) {
          return yield* Effect.die("window resize listener was not registered");
        }
        resize();
        yield* TestClock.adjust(250);
        fakeWindow.isFullScreen.mockReturnValue(true);

        yield* desktopWindow.flushMainWindowBounds;

        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 200, y: 130, width: 1400, height: 940 }]);
        assert.equal(fakeWindow.getBounds.mock.calls.length, 0);
        assert.equal(fakeWindow.getNormalBounds.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("flushes normal bounds when minimized before the debounce completes", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.getBounds.mockReturnValue({ x: -32_000, y: -32_000, width: 160, height: 28 });
      fakeWindow.getNormalBounds.mockReturnValue({ x: 180, y: 120, width: 1440, height: 960 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const resize = fakeWindow.windowListeners.get("resize");
        if (!resize) {
          return yield* Effect.die("window resize listener was not registered");
        }
        resize();
        yield* TestClock.adjust(250);
        fakeWindow.isMinimized.mockReturnValue(true);

        yield* desktopWindow.flushMainWindowBounds;

        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 180, y: 120, width: 1440, height: 960 }]);
        assert.equal(fakeWindow.getBounds.mock.calls.length, 0);
        assert.equal(fakeWindow.getNormalBounds.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("logs display lookup failures before falling back to the default size", () =>
    Effect.gen(function* () {
      const displayLookupFailure = new Error("screen API unavailable");
      vi.mocked(Electron.screen.getAllDisplays).mockImplementationOnce(() => {
        throw displayLookupFailure;
      });
      const logRecords: Array<{
        readonly message: unknown;
        readonly annotations: Readonly<Record<string, unknown>>;
      }> = [];
      const logger = Logger.make(({ fiber, message }) => {
        logRecords.push({
          message,
          annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
        });
      });
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        createdWindowOptions,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
      }).pipe(
        Effect.provide(Layer.mergeAll(layer, Logger.layer([logger], { mergeWithExisting: false }))),
      );

      const warning = logRecords.find(
        (record) =>
          Array.isArray(record.message) &&
          record.message[0] === "failed to read connected displays; using defaults",
      );
      assert.isDefined(warning);
      assert.strictEqual(warning.annotations.cause, displayLookupFailure);
      assert.equal(createdWindowOptions[0]?.width, 1100);
      assert.equal(createdWindowOptions[0]?.height, 780);
      assert.isUndefined(createdWindowOptions[0]?.x);
      assert.isUndefined(createdWindowOptions[0]?.y);
    }),
  );

  it.effect("persists the current main window bounds before the window closes", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.getBounds.mockReturnValue({ x: 240, y: 160, width: 1410, height: 930 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const writeStarted = yield* Deferred.make<void>();
      const allowWrite = yield* Deferred.make<void>();
      const flushCompleted = yield* Deferred.make<void>();
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
        beforeMainWindowBoundsUpdate: () =>
          Deferred.succeed(writeStarted, undefined).pipe(
            Effect.andThen(Deferred.await(allowWrite)),
            Effect.asVoid,
          ),
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const close = fakeWindow.windowListeners.get("close");
        if (!close) {
          return yield* Effect.die("window close listener was not registered");
        }
        close();
        yield* Deferred.await(writeStarted);
        fakeWindow.isDestroyed.mockReturnValue(true);

        const flushFiber = yield* desktopWindow.flushMainWindowBounds.pipe(
          Effect.andThen(Deferred.succeed(flushCompleted, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        assert.isFalse(yield* Deferred.isDone(flushCompleted));

        yield* Deferred.succeed(allowWrite, undefined);
        yield* Fiber.join(flushFiber);
        assert.isTrue(yield* Deferred.isDone(flushCompleted));

        assert.deepEqual(mainWindowBoundsUpdates, [
          {
            x: 240,
            y: 160,
            width: 1410,
            height: 930,
          },
        ]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("publishes native macOS fullscreen changes to the renderer", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const enterFullscreen = fakeWindow.windowListeners.get("enter-full-screen");
        const leaveFullscreen = fakeWindow.windowListeners.get("leave-full-screen");
        if (!enterFullscreen || !leaveFullscreen) {
          return yield* Effect.die("fullscreen listeners were not registered");
        }

        enterFullscreen();
        leaveFullscreen();
        assert.deepEqual(fakeWindow.send.mock.calls, [
          [WINDOW_FULLSCREEN_STATE_CHANNEL, true],
          [WINDOW_FULLSCREEN_STATE_CHANNEL, false],
        ]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("recovers when the development renderer is temporarily unreachable", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const didFailLoad = fakeWindow.webContentsListeners.get("did-fail-load");
        const didFinishLoad = fakeWindow.webContentsListeners.get("did-finish-load");
        if (!didFailLoad || !didFinishLoad) {
          return yield* Effect.die("renderer load listeners were not registered");
        }

        didFailLoad({}, -9, "ERR_UNEXPECTED", "t3code-dev://app/", true);
        assert.equal(fakeWindow.loadURL.mock.calls.length, 1);

        yield* TestClock.adjust(100);
        assert.deepEqual(fakeWindow.loadURL.mock.calls, [
          ["t3code-dev://app/"],
          ["t3code-dev://app/"],
        ]);
        assert.equal(fakeWindow.reload.mock.calls.length, 0);

        didFailLoad({}, -9, "ERR_UNEXPECTED", "t3code-dev://app/", true);
        didFinishLoad();
        yield* TestClock.adjust(250);
        assert.equal(fakeWindow.loadURL.mock.calls.length, 2);
        assert.equal(fakeWindow.reload.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it("retries only transient failures for the development renderer", () => {
    assert.isTrue(
      DesktopWindow.isRetryableDevelopmentRendererLoadFailure({
        applicationUrl: "t3code-dev://app/",
        errorCode: -102,
        isMainFrame: true,
        validatedUrl: "t3code-dev://app/",
      }),
    );
    assert.isFalse(
      DesktopWindow.isRetryableDevelopmentRendererLoadFailure({
        applicationUrl: "t3code-dev://app/",
        errorCode: -3,
        isMainFrame: true,
        validatedUrl: "t3code-dev://app/",
      }),
    );
    assert.isFalse(
      DesktopWindow.isRetryableDevelopmentRendererLoadFailure({
        applicationUrl: "t3code-dev://app/",
        errorCode: -102,
        isMainFrame: true,
        validatedUrl: "https://example.com/",
      }),
    );
  });

  it.effect("opens safe off-origin renderer navigations in the system browser", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const openedExternalUrls: unknown[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        openedExternalUrls,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const willNavigate = fakeWindow.webContentsListeners.get("will-navigate");
        if (!willNavigate) {
          return yield* Effect.die("will-navigate listener was not registered");
        }
        let prevented = false;
        willNavigate(
          {
            preventDefault: () => {
              prevented = true;
            },
          },
          "https://accounts.microsoft.com/oauth",
        );
        yield* Effect.promise(() => Promise.resolve());

        assert.isTrue(prevented);
        assert.deepEqual(openedExternalUrls, ["https://accounts.microsoft.com/oauth"]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "retries opening the real main on activate when a failed post-readiness open left only the splash",
    () =>
      Effect.gen(function* () {
        const splash = makeFakeBrowserWindow();
        const main = makeFakeBrowserWindow();
        // create #1 -> splash, #2 -> fails (the pool swallows this post-readiness
        // window-open error), #3 -> the real main on activate's retry.
        const scenario = yield* makeSplashScenario([splash.window, null, main.window]);

        yield* Effect.gen(function* () {
          const desktopWindow = yield* DesktopWindow.DesktopWindow;

          // 1. WSL-only boot shows the connecting splash.
          yield* desktopWindow.showConnectingSplash;
          assert.equal(yield* Ref.get(scenario.createCalls), 1);

          // 2. Backend reports ready, but opening the real main fails. The pool
          //    swallows that error in production, so handleBackendReady fails
          //    here without a registered main window -- only the splash is open.
          const readyExit = yield* Effect.exit(
            desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773")),
          );
          assert.equal(readyExit._tag, "Failure");
          assert.equal(yield* Ref.get(scenario.createCalls), 2);
          assert.isTrue(Option.isNone(yield* Ref.get(scenario.mainWindow)));

          // 3. Activating must not mistake the splash for the main window: it
          //    retries the open and brings up the real main instead of leaving
          //    the user stranded on "Connecting to WSL".
          yield* desktopWindow.activate;
          assert.equal(yield* Ref.get(scenario.createCalls), 3);
          const registeredMain = yield* Ref.get(scenario.mainWindow);
          assert.isTrue(Option.isSome(registeredMain));
          assert.equal(Option.getOrThrow(registeredMain), main.window);
        }).pipe(Effect.provide(scenario.layer));
      }),
  );

  it.effect(
    "re-reveals the connecting splash on activate while the backend is still cold-booting",
    () =>
      Effect.gen(function* () {
        const splash = makeFakeBrowserWindow();
        // Only the splash is ever created; the backend never reports ready.
        const scenario = yield* makeSplashScenario([splash.window]);

        yield* Effect.gen(function* () {
          const desktopWindow = yield* DesktopWindow.DesktopWindow;

          yield* desktopWindow.showConnectingSplash;
          assert.equal(yield* Ref.get(scenario.createCalls), 1);

          // Taskbar/dock activation during cold boot must bring the splash back
          // rather than no-op and leave it hidden until the backend finishes.
          yield* desktopWindow.activate;
          assert.equal(yield* Ref.get(scenario.createCalls), 1);
          assert.deepEqual(yield* Ref.get(scenario.revealedWindows), [splash.window]);
        }).pipe(Effect.provide(scenario.layer));
      }),
  );

  it.effect("does not dispatch menu actions to the splash before the backend is ready", () =>
    Effect.gen(function* () {
      const splash = makeFakeBrowserWindow();
      const main = makeFakeBrowserWindow();
      const scenario = yield* makeSplashScenario([splash.window, main.window]);

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;

        yield* desktopWindow.showConnectingSplash;
        yield* desktopWindow.dispatchMenuAction("open-settings");

        assert.equal(yield* Ref.get(scenario.createCalls), 1);
        assert.equal(splash.send.mock.calls.length, 0);
        assert.equal(main.send.mock.calls.length, 0);
      }).pipe(Effect.provide(scenario.layer));
    }),
  );

  it.effect("dispatches menu actions after backend readiness when no main window exists", () =>
    Effect.gen(function* () {
      const splash = makeFakeBrowserWindow();
      const main = makeFakeBrowserWindow();
      const scenario = yield* makeSplashScenario([splash.window, null, main.window]);

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;

        yield* desktopWindow.showConnectingSplash;
        const readyExit = yield* Effect.exit(
          desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773")),
        );
        assert.equal(readyExit._tag, "Failure");

        yield* desktopWindow.dispatchMenuAction("open-settings");

        assert.equal(yield* Ref.get(scenario.createCalls), 3);
        assert.deepEqual(main.send.mock.calls, [[MENU_ACTION_CHANNEL, "open-settings"]]);
      }).pipe(Effect.provide(scenario.layer));
    }),
  );
});
