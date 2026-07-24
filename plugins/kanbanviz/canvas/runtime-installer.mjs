import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open as openFile,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const RELEASE_REPOSITORY = "hngye02/KanbanViz-Releases";
const RUNTIME_MANIFEST_FILE = "runtime.json";
const SERVER_EXECUTABLE = "KanbanViz.Server.exe";
const VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[0-9A-F]{64}$/;
const LOCK_WAIT_TIMEOUT_MS = 35 * 60 * 1_000;
const LOCK_STALE_AFTER_MS = 60 * 60 * 1_000;
const LOCK_POLL_INTERVAL_MS = 500;
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1_000;
const EXTRACTION_TIMEOUT_MS = 10 * 60 * 1_000;

export class RuntimeInstallError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "RuntimeInstallError";
    this.code = code;
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function report(onProgress, update) {
  try {
    onProgress(update);
  } catch {
    // Progress reporting must never make installation fail.
  }
}

function manifestAssetName(manifest) {
  return `KanbanViz-Canvas-Server-${manifest.version}-${manifest.runtime}.zip`;
}

function expectedAssetUrl(manifest) {
  return `https://github.com/${RELEASE_REPOSITORY}/releases/download/`
    + `v${manifest.version}/${manifestAssetName(manifest)}`;
}

function validateManifest(payload) {
  if (
    payload === null
    || typeof payload !== "object"
    || payload.schemaVersion !== 1
    || typeof payload.version !== "string"
    || !VERSION_PATTERN.test(payload.version)
    || payload.runtime !== "win-x64"
    || typeof payload.assetUrl !== "string"
    || typeof payload.sha256 !== "string"
  ) {
    throw new RuntimeInstallError(
      "kanbanviz_runtime_manifest_invalid",
      "The KanbanViz runtime manifest is missing required version, runtime, URL, or SHA256 fields.",
    );
  }

  const manifest = {
    schemaVersion: 1,
    version: payload.version,
    runtime: payload.runtime,
    assetUrl: payload.assetUrl,
    sha256: payload.sha256.toUpperCase(),
  };

  if (
    !SHA256_PATTERN.test(manifest.sha256)
    || manifest.assetUrl !== expectedAssetUrl(manifest)
  ) {
    throw new RuntimeInstallError(
      "kanbanviz_runtime_manifest_invalid",
      "The KanbanViz runtime manifest contains an unexpected asset URL or SHA256.",
    );
  }

  return Object.freeze(manifest);
}

export async function readRuntimeManifest(extensionDirectory) {
  const manifestPath = join(extensionDirectory, RUNTIME_MANIFEST_FILE);
  let raw;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    throw new RuntimeInstallError(
      "kanbanviz_runtime_manifest_missing",
      `The KanbanViz runtime manifest was not found at "${manifestPath}". Reinstall the plugin.`,
      { cause: error },
    );
  }

  try {
    return validateManifest(JSON.parse(raw));
  } catch (error) {
    if (error instanceof RuntimeInstallError) {
      throw error;
    }

    throw new RuntimeInstallError(
      "kanbanviz_runtime_manifest_invalid",
      `The KanbanViz runtime manifest is not valid JSON: ${error.message}`,
      { cause: error },
    );
  }
}

function defaultInstallRoot() {
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (!localAppData) {
    throw new RuntimeInstallError(
      "kanbanviz_runtime_storage_unavailable",
      "LOCALAPPDATA is unavailable, so the KanbanViz runtime cannot be installed.",
    );
  }

  return join(
    localAppData,
    "KanbanViz",
    "canvas-extension",
    "runtimes",
  );
}

function installDirectory(installRoot, manifest) {
  return join(installRoot, `${manifest.version}-${manifest.runtime}`);
}

function serverExecutable(installDirectoryPath) {
  return join(installDirectoryPath, "server", SERVER_EXECUTABLE);
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function findInstalledRuntime(installRoot, manifest) {
  const directory = installDirectory(installRoot, manifest);
  const executable = serverExecutable(directory);
  if (!await isFile(executable)) {
    return null;
  }

  try {
    const installedManifest = validateManifest(JSON.parse(
      await readFile(join(directory, RUNTIME_MANIFEST_FILE), "utf8"),
    ));
    if (
      installedManifest.version !== manifest.version
      || installedManifest.runtime !== manifest.runtime
      || installedManifest.assetUrl !== manifest.assetUrl
      || installedManifest.sha256 !== manifest.sha256
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return executable;
}

async function acquireInstallLock({
  lockPath,
  installRoot,
  manifest,
  onProgress,
}) {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const handle = await openFile(lockPath, "wx");
      await handle.writeFile(JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }));
      return { handle, installedExecutable: null };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw new RuntimeInstallError(
          "kanbanviz_runtime_lock_failed",
          `The KanbanViz runtime install lock could not be created: ${error.message}`,
          { cause: error },
        );
      }
    }

    const installedExecutable = await findInstalledRuntime(
      installRoot,
      manifest,
    );
    if (installedExecutable) {
      return { handle: null, installedExecutable };
    }

    try {
      const lockStat = await stat(lockPath);
      if (Date.now() - lockStat.mtimeMs > LOCK_STALE_AFTER_MS) {
        await rm(lockPath, { force: true });
        continue;
      }
    } catch {
      continue;
    }

    report(onProgress, {
      phase: "waiting",
      message: "Another KanbanViz session is installing the runtime...",
      progress: null,
    });
    await wait(LOCK_POLL_INTERVAL_MS);
  }

  throw new RuntimeInstallError(
    "kanbanviz_runtime_lock_timeout",
    "Timed out waiting for another KanbanViz runtime installation to finish.",
  );
}

async function releaseInstallLock(lockPath, handle) {
  try {
    await handle?.close();
  } finally {
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

async function writeBuffer(file, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await file.write(
      buffer,
      offset,
      buffer.length - offset,
      null,
    );
    if (bytesWritten <= 0) {
      throw new Error("The runtime download stopped writing before completion.");
    }
    offset += bytesWritten;
  }
}

async function downloadRuntime(manifest, archivePath, onProgress) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let file;

  report(onProgress, {
    phase: "downloading",
    message: "Downloading the KanbanViz server runtime...",
    progress: 0,
  });

  try {
    const response = await fetch(manifest.assetUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "application/octet-stream",
        "User-Agent": "KanbanViz-Canvas-Extension",
      },
      cache: "no-store",
    });
    if (!response.ok || !response.body) {
      throw new RuntimeInstallError(
        "kanbanviz_runtime_download_failed",
        `The KanbanViz runtime download returned HTTP ${response.status}.`,
      );
    }

    const lengthHeader = response.headers.get("content-length");
    const totalBytes = lengthHeader && Number.isSafeInteger(Number(lengthHeader))
      ? Number(lengthHeader)
      : null;
    const hash = createHash("sha256");
    let receivedBytes = 0;
    let lastReportedAt = 0;

    file = await openFile(archivePath, "wx");
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      await writeBuffer(file, buffer);
      hash.update(buffer);
      receivedBytes += buffer.length;

      const now = Date.now();
      if (now - lastReportedAt >= 250) {
        report(onProgress, {
          phase: "downloading",
          message: "Downloading the KanbanViz server runtime...",
          progress: totalBytes
            ? Math.min(99, Math.round(receivedBytes / totalBytes * 100))
            : null,
          receivedBytes,
          totalBytes,
        });
        lastReportedAt = now;
      }
    }

    await file.sync();
    const actualHash = hash.digest("hex").toUpperCase();

    report(onProgress, {
      phase: "verifying",
      message: "Verifying the runtime download...",
      progress: 100,
      receivedBytes,
      totalBytes,
    });

    if (actualHash !== manifest.sha256) {
      throw new RuntimeInstallError(
        "kanbanviz_runtime_hash_mismatch",
        "The downloaded KanbanViz runtime failed SHA256 verification and was discarded.",
      );
    }
  } catch (error) {
    if (error instanceof RuntimeInstallError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new RuntimeInstallError(
        "kanbanviz_runtime_download_timeout",
        "The KanbanViz runtime download timed out.",
        { cause: error },
      );
    }
    throw new RuntimeInstallError(
      "kanbanviz_runtime_download_failed",
      `The KanbanViz runtime could not be downloaded: ${error.message}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
    await file?.close().catch(() => {});
  }
}

async function extractRuntime({
  archivePath,
  stagingDirectory,
  manifest,
  onProgress,
}) {
  report(onProgress, {
    phase: "extracting",
    message: "Installing the verified KanbanViz runtime...",
    progress: null,
  });

  await mkdir(stagingDirectory);

  const powershell = process.env.SystemRoot
    ? join(
      process.env.SystemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    )
    : "powershell.exe";

  try {
    await execFileAsync(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Expand-Archive -LiteralPath $env:KANBANVIZ_RUNTIME_ARCHIVE "
          + "-DestinationPath $env:KANBANVIZ_RUNTIME_DESTINATION -Force",
      ],
      {
        timeout: EXTRACTION_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1_024 * 1_024,
        env: {
          ...process.env,
          KANBANVIZ_RUNTIME_ARCHIVE: archivePath,
          KANBANVIZ_RUNTIME_DESTINATION: stagingDirectory,
        },
      },
    );
  } catch (error) {
    throw new RuntimeInstallError(
      "kanbanviz_runtime_extract_failed",
      `The verified KanbanViz runtime could not be extracted: ${error.message}`,
      { cause: error },
    );
  }

  if (!await isFile(serverExecutable(stagingDirectory))) {
    throw new RuntimeInstallError(
      "kanbanviz_runtime_extract_incomplete",
      "The verified KanbanViz runtime archive did not contain KanbanViz.Server.exe.",
    );
  }

  await writeFile(
    join(stagingDirectory, RUNTIME_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

export async function ensureRuntimeInstalled({
  extensionDirectory,
  onProgress = () => {},
  installRoot = defaultInstallRoot(),
}) {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new RuntimeInstallError(
      "kanbanviz_platform_unsupported",
      "Automatic KanbanViz runtime installation currently supports Windows x64 only.",
    );
  }

  const manifest = await readRuntimeManifest(extensionDirectory);
  const installedExecutable = await findInstalledRuntime(
    installRoot,
    manifest,
  );
  if (installedExecutable) {
    report(onProgress, {
      phase: "installed",
      message: "KanbanViz runtime is already installed.",
      progress: 100,
    });
    return installedExecutable;
  }

  await mkdir(installRoot, { recursive: true });
  const finalDirectory = installDirectory(installRoot, manifest);
  const lockPath = `${finalDirectory}.lock`;
  const lock = await acquireInstallLock({
    lockPath,
    installRoot,
    manifest,
    onProgress,
  });
  if (lock.installedExecutable) {
    return lock.installedExecutable;
  }

  const identifier = `${process.pid}-${randomUUID()}`;
  const archivePath = join(installRoot, `.download-${identifier}.zip`);
  const stagingDirectory = join(installRoot, `.install-${identifier}`);

  try {
    const recheckedExecutable = await findInstalledRuntime(
      installRoot,
      manifest,
    );
    if (recheckedExecutable) {
      return recheckedExecutable;
    }

    await downloadRuntime(manifest, archivePath, onProgress);
    await extractRuntime({
      archivePath,
      stagingDirectory,
      manifest,
      onProgress,
    });

    await rm(finalDirectory, { recursive: true, force: true });
    await rename(stagingDirectory, finalDirectory);

    const executable = await findInstalledRuntime(installRoot, manifest);
    if (!executable) {
      throw new RuntimeInstallError(
        "kanbanviz_runtime_install_incomplete",
        "The KanbanViz runtime installation completed without a usable server executable.",
      );
    }

    report(onProgress, {
      phase: "installed",
      message: "KanbanViz runtime installed.",
      progress: 100,
    });
    return executable;
  } finally {
    await rm(archivePath, { force: true }).catch(() => {});
    await rm(stagingDirectory, { recursive: true, force: true })
      .catch(() => {});
    await releaseInstallLock(lockPath, lock.handle);
  }
}
