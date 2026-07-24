import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  CanvasError,
  createCanvas,
  joinSession,
} from "@github/copilot-sdk/extension";
import { createBootstrapServer } from "./bootstrap-server.mjs";
import {
  ensureRuntimeInstalled,
  RuntimeInstallError,
} from "./runtime-installer.mjs";

const execFileAsync = promisify(execFile);

const PRODUCT_ID = "KanbanViz";
const EXTENSION_API_VERSION = "1.0";
const BASE_URL = "http://127.0.0.1:5364";
const HEALTH_URL = `${BASE_URL}/api/extension/health`;
const HEALTH_REQUEST_TIMEOUT_MS = 1_500;
const STARTUP_TIMEOUT_MS = 30_000;
const STARTUP_POLL_INTERVAL_MS = 250;
const GIT_TIMEOUT_MS = 1_500;

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const packagedServerExecutable = join(
  extensionDirectory,
  "server",
  "KanbanViz.Server.exe",
);

let startupPromise = null;
let bootstrapPromise = null;
let startupStatus = {
  phase: "checking",
  message: "Checking the local KanbanViz server...",
  detail: "The first launch may install a verified Windows runtime.",
  progress: null,
};

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function updateStartupStatus(update) {
  startupStatus = {
    ...startupStatus,
    ...update,
    updatedAt: new Date().toISOString(),
  };
}

function getStartupStatus() {
  return startupStatus;
}

function isCompatibleHealth(payload) {
  return (
    payload !== null
    && typeof payload === "object"
    && payload.product === PRODUCT_ID
    && payload.extensionApiVersion === EXTENSION_API_VERSION
    && payload.supportsCanvasHost === true
  );
}

async function probeHealth() {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    HEALTH_REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(HEALTH_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!response.ok) {
      return {
        kind: "incompatible",
        message: `Port 5364 responded with HTTP ${response.status}, not the KanbanViz extension API.`,
      };
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      return {
        kind: "incompatible",
        message: `Port 5364 returned invalid KanbanViz health JSON: ${errorMessage(error)}`,
      };
    }

    if (!isCompatibleHealth(payload)) {
      const product = typeof payload?.product === "string"
        ? payload.product
        : "unknown";
      const apiVersion = typeof payload?.extensionApiVersion === "string"
        ? payload.extensionApiVersion
        : "unknown";
      return {
        kind: "incompatible",
        message:
          `Port 5364 is serving ${product} extension API ${apiVersion}; `
          + `KanbanViz Canvas requires ${PRODUCT_ID} extension API ${EXTENSION_API_VERSION}.`,
      };
    }

    return { kind: "ready", health: payload };
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        kind: "unavailable",
        message: `The KanbanViz health request timed out after ${HEALTH_REQUEST_TIMEOUT_MS} ms.`,
      };
    }

    return { kind: "unavailable", message: errorMessage(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function packagedServer() {
  try {
    return (await stat(packagedServerExecutable)).isFile()
      ? packagedServerExecutable
      : null;
  } catch {
    return null;
  }
}

async function resolveServerExecutable() {
  const packaged = await packagedServer();
  if (packaged) {
    return packaged;
  }

  try {
    return await ensureRuntimeInstalled({
      extensionDirectory,
      onProgress: (progress) => updateStartupStatus({
        ...progress,
        detail: progress.receivedBytes
          ? "The downloaded archive is verified before any files are used."
          : "The runtime is cached for future Canvas sessions.",
      }),
    });
  } catch (error) {
    if (error instanceof RuntimeInstallError) {
      throw new CanvasError(error.code, error.message);
    }
    throw error;
  }
}

async function startServer() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new CanvasError(
      "kanbanviz_platform_unsupported",
      "Automatic KanbanViz startup currently supports Windows x64 only. "
        + `Start a compatible KanbanViz server manually at ${BASE_URL} on this platform.`,
    );
  }

  const serverExecutable = await resolveServerExecutable();
  updateStartupStatus({
    phase: "starting",
    message: "Starting the KanbanViz server...",
    detail: "The server listens only on 127.0.0.1.",
    progress: 100,
  });

  const { spawn } = await import("node:child_process");
  let spawnError = null;
  let exit = null;
  const child = spawn(serverExecutable, ["--canvas-host"], {
    cwd: dirname(serverExecutable),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });

  child.once("error", (error) => {
    spawnError = error;
  });
  child.once("exit", (code, signal) => {
    exit = { code, signal };
  });
  child.unref();

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new CanvasError(
        "kanbanviz_server_start_failed",
        `The KanbanViz server could not be started: ${errorMessage(spawnError)}`,
      );
    }

    const health = await probeHealth();
    if (health.kind === "ready") {
      return health.health;
    }
    if (health.kind === "incompatible") {
      child.kill();
      throw new CanvasError(
        "kanbanviz_incompatible_server",
        `${health.message} Stop the process using port 5364 and try again.`,
      );
    }

    if (exit) {
      const detail = exit.signal
        ? `signal ${exit.signal}`
        : `exit code ${exit.code ?? "unknown"}`;
      throw new CanvasError(
        "kanbanviz_server_start_failed",
        `The KanbanViz server stopped during startup (${detail}). `
          + "Another KanbanViz process may own the server without being reachable at "
          + `${BASE_URL}, or another application may be using port 5364.`,
      );
    }

    await wait(STARTUP_POLL_INTERVAL_MS);
  }

  child.kill();
  throw new CanvasError(
    "kanbanviz_server_start_timeout",
    `KanbanViz did not become ready at ${HEALTH_URL} within `
      + `${STARTUP_TIMEOUT_MS / 1_000} seconds.`,
  );
}

async function ensureServerAvailable() {
  const health = await probeHealth();
  if (health.kind === "ready") {
    return health.health;
  }
  if (health.kind === "incompatible") {
    throw new CanvasError(
      "kanbanviz_incompatible_server",
      `${health.message} Stop the process using port 5364 and try again.`,
    );
  }

  if (!startupPromise) {
    startupPromise = startServer().finally(() => {
      startupPromise = null;
    });
  }

  return startupPromise;
}

function kickOffServerStartup() {
  updateStartupStatus({
    phase: "checking",
    message: "Preparing the KanbanViz server...",
    detail: "The first launch may download a verified Windows runtime.",
    progress: null,
  });

  void ensureServerAvailable()
    .then(() => updateStartupStatus({
      phase: "ready",
      message: "KanbanViz is ready.",
      detail: "Opening the Canvas...",
      progress: 100,
    }))
    .catch((error) => updateStartupStatus({
      phase: "error",
      message: "KanbanViz could not be started.",
      detail: errorMessage(error),
      progress: null,
    }));
}

async function bootstrapUrl(targetUrl) {
  if (!bootstrapPromise) {
    bootstrapPromise = createBootstrapServer({
      applicationOrigin: BASE_URL,
      getStatus: getStartupStatus,
      retry: kickOffServerStartup,
    });
  }

  return (await bootstrapPromise).urlFor(targetUrl);
}

function parseGitHubRepository(remote) {
  const trimmed = remote.trim().replace(/\.git$/i, "");
  if (!trimmed) {
    return null;
  }

  let repositoryPath;
  const scpStyle = /^git@github\.com:(.+)$/i.exec(trimmed);
  if (scpStyle) {
    repositoryPath = scpStyle[1];
  } else {
    let remoteUrl;
    try {
      remoteUrl = new URL(trimmed);
    } catch {
      return null;
    }

    if (remoteUrl.hostname.toLowerCase() !== "github.com") {
      return null;
    }
    repositoryPath = remoteUrl.pathname.replace(/^\/+/, "");
  }

  const parts = repositoryPath.split("/").filter(Boolean);
  if (parts.length !== 2 || parts.some((part) => part.trim().length === 0)) {
    return null;
  }

  return `${parts[0]}/${parts[1]}`;
}

async function inferRepository(context) {
  const workingDirectory = context.session?.workingDirectory;
  if (
    typeof workingDirectory !== "string"
    || workingDirectory.trim().length === 0
  ) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", workingDirectory, "remote", "get-url", "origin"],
      {
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8_192,
        encoding: "utf8",
      },
    );
    return parseGitHubRepository(stdout);
  } catch {
    return null;
  }
}

function applicationUrl(repository) {
  const url = new URL(BASE_URL);
  url.searchParams.set("canvas", "1");
  if (repository) {
    url.searchParams.set("repository", repository);
  }
  return url.toString();
}

const canvas = createCanvas({
  id: "kanbanviz",
  displayName: "KanbanViz",
  description:
    "Visualize local GitHub Copilot CLI sessions by repository, search them, "
    + "and inspect continuous or deep insights.",
  open: async (context) => {
    const [health, repository] = await Promise.all([
      probeHealth(),
      inferRepository(context),
    ]);
    const targetUrl = applicationUrl(repository);

    if (health.kind === "ready") {
      return {
        title: repository ? `KanbanViz - ${repository}` : "KanbanViz",
        url: targetUrl,
        status: "ready",
      };
    }
    if (health.kind === "incompatible") {
      throw new CanvasError(
        "kanbanviz_incompatible_server",
        `${health.message} Stop the process using port 5364 and try again.`,
      );
    }

    const url = await bootstrapUrl(targetUrl);
    kickOffServerStartup();

    return {
      title: repository ? `KanbanViz - ${repository}` : "KanbanViz",
      url,
      status: "ready",
    };
  },
});

await joinSession({ canvases: [canvas] });
