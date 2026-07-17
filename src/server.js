import { createServer } from "node:http";
import { connect } from "node:net";
import { createReadStream, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { cp, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { freemem, totalmem } from "node:os";
import { WebSocketServer } from "ws";
import { COMMANDS, completeCommand } from "./minecraftCommands.js";

const ROOT = resolve(import.meta.dirname, "..");
const PUBLIC_DIR = join(ROOT, "public");
const DATA_DIR = join(ROOT, "data");
const SERVERS_DIR = join(ROOT, "servers");
const CONFIG_FILE = join(DATA_DIR, "servers.json");
const BACKUP_DIR = join(DATA_DIR, "backups");
const HOME_DIR = resolve(process.env.HOME || "/home/leonardo");
const DEFAULT_IMPORT_BROWSER_DIR = existsSync(join(HOME_DIR, "Descargas"))
  ? join(HOME_DIR, "Descargas")
  : HOME_DIR;
const PORT = Number(process.env.PORT || 4545);
const PAGE_SIZE = 4096;
const IS_IMPORT_WORKER = process.argv[2] === "--import-worker";
const CLOCK_TICKS_PER_SECOND = Number(spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout || 100);
const RESTART_WINDOW_MS = 5 * 60 * 1000;
const RESTART_DELAY_MS = 10 * 1000;
const MAX_RESTARTS_IN_WINDOW = 3;
const RCON_TIMEOUT_MS = 3000;
const RCON_DEFAULT_HOST = "127.0.0.1";
const PROPERTY_FIELDS = [
  { key: "motd", label: "Mensaje del servidor", type: "text", description: "Texto que aparece en la lista de servidores." },
  { key: "difficulty", label: "Dificultad", type: "select", options: ["peaceful", "easy", "normal", "hard"] },
  { key: "gamemode", label: "Modo de juego", type: "select", options: ["survival", "creative", "adventure", "spectator"] },
  { key: "hardcore", label: "Hardcore", type: "boolean" },
  { key: "pvp", label: "PvP", type: "boolean" },
  { key: "online-mode", label: "Online mode", type: "boolean", description: "Valida cuentas oficiales de Minecraft." },
  { key: "white-list", label: "Whitelist", type: "boolean" },
  { key: "enforce-whitelist", label: "Forzar whitelist", type: "boolean" },
  { key: "max-players", label: "Jugadores maximos", type: "number", min: 1, max: 200 },
  { key: "server-port", label: "Puerto", type: "number", min: 1, max: 65535 },
  { key: "view-distance", label: "View distance", type: "number", min: 2, max: 32 },
  { key: "simulation-distance", label: "Simulation distance", type: "number", min: 2, max: 32 },
  { key: "spawn-protection", label: "Proteccion del spawn", type: "number", min: 0, max: 1000 },
  { key: "allow-flight", label: "Permitir vuelo", type: "boolean" },
  { key: "enable-command-block", label: "Command blocks", type: "boolean" },
  { key: "spawn-animals", label: "Spawn animales", type: "boolean" },
  { key: "spawn-monsters", label: "Spawn monstruos", type: "boolean" },
  { key: "spawn-npcs", label: "Spawn NPCs", type: "boolean" },
  { key: "level-name", label: "Nombre del mundo", type: "text", description: "Cambiar esto apunta a otra carpeta de mundo." }
];
const PROPERTY_KEYS = new Set(PROPERTY_FIELDS.map((field) => field.key));

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(BACKUP_DIR, { recursive: true });
mkdirSync(SERVERS_DIR, { recursive: true });

const logWatchers = new Map();
const logBuffers = new Map();
const clients = new Set();
const manualStops = new Set();
const screenStates = new Map();
const playerState = new Map();
const scheduledRestarts = new Set();
const restartAttempts = new Map();
const runningBackups = new Set();
const lastBackupRuns = new Map();
const usageSamples = new Map();
const importJobs = new Map();
let rconRequestId = 1;

function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
}

function saveConfig(config) {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function saveServerRecord(serverId, updates) {
  const config = loadConfig();
  const index = config.servers.findIndex((server) => server.id === serverId);
  if (index === -1) {
    throw new Error("Servidor no encontrado.");
  }
  config.servers[index] = { ...config.servers[index], ...updates };
  saveConfig(config);
  return config.servers[index];
}

function deleteServerRecord(serverId) {
  const config = loadConfig();
  const index = config.servers.findIndex((server) => server.id === serverId);
  if (index === -1) {
    throw new Error("Servidor no encontrado.");
  }

  const [server] = config.servers.splice(index, 1);
  saveConfig(config);
  stopLogWatcher(server.id);
  logBuffers.delete(server.id);
  playerState.delete(server.id);
  screenStates.delete(server.id);
  usageSamples.delete(server.id);
  scheduledRestarts.delete(server.id);
  restartAttempts.delete(server.id);
  manualStops.delete(server.id);
  return server;
}

function normalizeBoolean(value) {
  return value === true || value === "true" || value === "on" || value === 1 || value === "1";
}

function cronFieldIsValid(field, min, max) {
  return field.split(",").every((part) => {
    const item = part.trim();
    if (item === "*") {
      return true;
    }
    if (/^\*\/\d+$/.test(item)) {
      return Number(item.slice(2)) > 0;
    }
    const rangeMatch = item.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      return start >= min && end <= max && start <= end;
    }
    const number = Number(item);
    return Number.isInteger(number) && number >= min && number <= max;
  });
}

function validateCronSchedule(value) {
  const schedule = String(value || "").trim();
  if (!schedule) {
    return "";
  }

  const fields = schedule.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("El cron debe tener 5 campos: minuto hora dia mes dia-semana.");
  }
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  if (!fields.every((field, index) => cronFieldIsValid(field, ranges[index][0], ranges[index][1]))) {
    throw new Error("El cron tiene un campo fuera de rango o con formato invalido.");
  }

  return schedule;
}

function normalizeWebhookUrl(value) {
  const url = String(value || "").trim();
  if (!url) {
    return "";
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("El webhook debe ser una URL valida.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("El webhook debe usar http o https.");
  }

  return parsed.toString();
}

function updateAutomationSettings(serverId, values) {
  const updates = {
    autoRestart: normalizeBoolean(values?.autoRestart),
    backupSchedule: validateCronSchedule(values?.backupSchedule),
    notifyWebhookUrl: normalizeWebhookUrl(values?.notifyWebhookUrl)
  };
  return saveServerRecord(serverId, updates);
}

function slugifyServerId(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeRamLabel(value) {
  const match = String(value || "").trim().match(/^(\d+)\s*([GM])?$/i);
  if (!match) {
    return "";
  }
  return `${Number(match[1])}${(match[2] || "G").toUpperCase()}`;
}

function createServerRecord(config, body) {
  const name = String(body?.name || "").trim();
  const id = slugifyServerId(body?.id || name);
  const serverPath = resolve(String(body?.path || "").trim());
  const command = String(body?.command || "bash start.sh").trim();
  const port = Number(body?.port || 25565);
  const minRam = normalizeRamLabel(body?.minRam);
  const maxRam = normalizeRamLabel(body?.maxRam);

  if (!name) {
    throw new Error("El nombre de la instancia es obligatorio.");
  }
  if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error("El id solo puede usar letras minusculas, numeros y guiones.");
  }
  if (config.servers.some((server) => server.id === id)) {
    throw new Error("Ya existe un servidor con ese id.");
  }
  if (!existsSync(serverPath) || !statSync(serverPath).isDirectory()) {
    throw new Error(`La carpeta no existe o no es directorio: ${serverPath}`);
  }
  if (config.servers.some((server) => resolve(server.path) === serverPath)) {
    throw new Error("Ya hay una instancia registrada con esa carpeta.");
  }
  if (!command || !parseCommandLine(command).length) {
    throw new Error("El comando de arranque es obligatorio.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("El puerto debe estar entre 1 y 65535.");
  }
  if (config.servers.some((server) => Number(server.port) === port)) {
    throw new Error("Ya hay una instancia registrada con ese puerto.");
  }
  if (minRam && maxRam && ramLabelToGb(minRam) > ramLabelToGb(maxRam)) {
    throw new Error("La RAM minima no puede ser mayor que la maxima.");
  }

  return {
    id,
    name,
    path: serverPath,
    command,
    port,
    java: String(body?.java || "system").trim() || "system",
    minRam,
    maxRam,
    autoRestart: normalizeBoolean(body?.autoRestart),
    backupSchedule: validateCronSchedule(body?.backupSchedule),
    notifyWebhookUrl: normalizeWebhookUrl(body?.notifyWebhookUrl),
    notes: String(body?.notes || "").trim()
  };
}

function uniqueServerPath(baseName) {
  const slug = slugifyServerId(baseName) || "imported-server";
  let candidate = join(SERVERS_DIR, slug);
  let counter = 2;

  while (existsSync(candidate)) {
    candidate = join(SERVERS_DIR, `${slug}-${counter}`);
    counter += 1;
  }

  return candidate;
}

function nextAvailablePort(config, preferred = 25566) {
  const used = new Set(config.servers.map((server) => Number(server.port)).filter(Boolean));
  let port = Number(preferred) || 25566;

  while (used.has(port)) {
    port += 1;
  }

  return port;
}

function resolveImportBrowserPath(requestedPath = "") {
  let target = requestedPath
    ? resolve(String(requestedPath))
    : DEFAULT_IMPORT_BROWSER_DIR;

  if (target !== HOME_DIR && !target.startsWith(`${HOME_DIR}${sep}`)) {
    throw new Error("El explorador de importacion solo puede navegar dentro de tu carpeta personal.");
  }

  if (existsSync(target) && statSync(target).isFile()) {
    target = dirname(target);
  }

  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new Error("La ruta del explorador no existe o no es una carpeta.");
  }

  return target;
}

function importBrowserSummary(requestedPath = "") {
  const target = resolveImportBrowserPath(requestedPath);
  const entries = [];

  for (const entry of readdirSync(target)) {
    const fullPath = join(target, entry);
    let entryStat;

    try {
      entryStat = statSync(fullPath);
    } catch {
      continue;
    }

    const directory = entryStat.isDirectory();
    const zip = entryStat.isFile() && extname(entry).toLowerCase() === ".zip";

    if (!directory && !zip) {
      continue;
    }

    entries.push({
      name: entry,
      path: fullPath,
      directory,
      size: entryStat.size
    });
  }

  entries.sort((left, right) => Number(right.directory) - Number(left.directory) || left.name.localeCompare(right.name));

  const parent = target === HOME_DIR
    ? null
    : dirname(target);

  return { path: target, parent, entries };
}

function readJsonIfExists(file) {
  if (!existsSync(file)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function curseForgeManifestInfo(folder) {
  const manifest = readJsonIfExists(join(folder, "manifest.json"));
  if (manifest?.manifestType !== "minecraftModpack") {
    return null;
  }

  return {
    name: manifest.name || "",
    version: manifest.version || "",
    minecraftVersion: manifest.minecraft?.version || "",
    modLoader: manifest.minecraft?.modLoaders?.find((loader) => loader.primary)?.id || "",
    files: Array.isArray(manifest.files) ? manifest.files.length : 0
  };
}

function curseForgeManifestSummary(manifest) {
  return {
    name: manifest.name || "",
    version: manifest.version || "",
    minecraftVersion: manifest.minecraft?.version || "",
    modLoader: manifest.minecraft?.modLoaders?.find((loader) => loader.primary)?.id || "",
    files: Array.isArray(manifest.files) ? manifest.files.length : 0
  };
}

function inspectZipForCurseForge(sourcePath) {
  const result = spawnSync("unzip", ["-p", sourcePath, "manifest.json"], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024
  });

  if (result.status !== 0 || !result.stdout) {
    return null;
  }

  try {
    const manifest = JSON.parse(result.stdout);
    if (manifest.manifestType !== "minecraftModpack") {
      return null;
    }
    return curseForgeManifestSummary(manifest);
  } catch {
    return null;
  }
}

function downloadFile(url, target) {
  const result = spawnSync("curl", ["-L", "-f", "--retry", "2", "-o", target, url], { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `No se pudo descargar ${url}`).trim());
  }
}

function curseForgeDownloadInfo(projectID, fileID) {
  const url = `https://www.curseforge.com/api/v1/mods/${projectID}/files/${fileID}/download`;
  const result = spawnSync("curl", [
    "-L",
    "-sS",
    "-I",
    "-o",
    "/dev/null",
    "-w",
    "%{url_effective}\n%{content_type}",
    url
  ], { encoding: "utf8" });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "No se pudo resolver la descarga de CurseForge.").trim());
  }

  const [effectiveUrl = "", contentType = ""] = result.stdout.trim().split(/\r?\n/);
  return { url, effectiveUrl, contentType };
}

function fileNameFromUrl(url, fallback) {
  try {
    const parsed = new URL(url);
    const name = decodeURIComponent(basename(parsed.pathname));
    return name || fallback;
  } catch {
    return fallback;
  }
}

function installNeoForge(targetPath, loaderId) {
  if (!loaderId.startsWith("neoforge-")) {
    throw new Error(`Convertidor no soportado todavia para modloader: ${loaderId || "desconocido"}`);
  }

  const version = loaderId.replace(/^neoforge-/, "");
  const installer = join(targetPath, `neoforge-${version}-installer.jar`);
  const url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`;
  downloadFile(url, installer);

  const result = spawnSync("java", ["-jar", installer, "--installServer"], {
    cwd: targetPath,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "No se pudo instalar NeoForge.").trim());
  }
}

function moveClientOnlyMods(modsDir) {
  const clientOnlyIds = new Set([
    "armor_hud",
    "drippyloadingscreen",
    "entity_model_features",
    "entity_texture_features",
    "immersiveoverlays",
    "weatherrefind"
  ]);
  const disabledDir = join(dirname(modsDir), "mods-disabled", "client");
  const moved = [];

  for (const file of readdirSync(modsDir)) {
    if (!file.toLowerCase().endsWith(".jar")) {
      continue;
    }

    const source = join(modsDir, file);
    const metadata = spawnSync("unzip", ["-p", source, "META-INF/neoforge.mods.toml", "META-INF/mods.toml", "fabric.mod.json"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    }).stdout || "";
    const isClientOnly = [...clientOnlyIds].some((id) =>
      new RegExp(`modId\\s*=\\s*"${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(metadata)
    );

    if (isClientOnly) {
      mkdirSync(disabledDir, { recursive: true });
      renameSync(source, join(disabledDir, file));
      moved.push(file);
    }
  }

  return moved;
}

function convertCurseForgeExport(sourcePath, config, body, extractedPath = "", progress = () => {}) {
  const exportRoot = extractedPath || sourcePath;
  const manifest = readJsonIfExists(join(exportRoot, "manifest.json"));
  if (manifest?.manifestType !== "minecraftModpack") {
    throw new Error("No encontre manifest.json de CurseForge para convertir.");
  }

  const summary = curseForgeManifestSummary(manifest);
  const name = String(body?.name || "").trim() || summary.name || basename(sourcePath).replace(/\.zip$/i, "");
  const targetPath = uniqueServerPath(`${name}-server`);
  const modsDir = join(targetPath, "mods");
  const skipped = [];
  const failed = [];
  const downloaded = [];

  mkdirSync(targetPath, { recursive: true });
  mkdirSync(modsDir, { recursive: true });

  const overridesRoot = join(exportRoot, manifest.overrides || "overrides");
  for (const folder of ["config", "defaultconfigs", "kubejs"]) {
    const source = join(overridesRoot, folder);
    if (existsSync(source)) {
      cpSync(source, join(targetPath, folder), { recursive: true });
    }
  }

  progress({ stage: "loader", message: `Instalando ${summary.modLoader || "loader"}...`, current: 0, total: 1 });
  installNeoForge(targetPath, summary.modLoader);
  progress({ stage: "loader", message: "Loader instalado.", current: 1, total: 1 });

  const files = manifest.files || [];
  let processed = 0;

  progress({ stage: "mods", message: "Descargando mods...", current: processed, total: files.length });

  for (const file of files) {
    try {
      const info = curseForgeDownloadInfo(file.projectID, file.fileID);
      const nameFromUrl = fileNameFromUrl(info.effectiveUrl, `${file.fileID}.jar`);
      const isJar = nameFromUrl.toLowerCase().endsWith(".jar") || /java-archive|jar/i.test(info.contentType);
      if (!isJar) {
        skipped.push({ ...file, name: nameFromUrl, reason: "not-jar" });
        continue;
      }

      const target = join(modsDir, nameFromUrl.toLowerCase().endsWith(".jar") ? nameFromUrl : `${file.fileID}.jar`);
      downloadFile(info.url, target);
      downloaded.push(basename(target));
    } catch (error) {
      failed.push({ ...file, error: error.message });
    } finally {
      processed += 1;
      progress({
        stage: "mods",
        message: `Procesando mods: ${processed}/${files.length}`,
        current: processed,
        total: files.length
      });
    }
  }

  progress({ stage: "client-mods", message: "Apartando mods client-only...", current: 0, total: 1 });
  const disabledClientMods = moveClientOnlyMods(modsDir);
  progress({ stage: "client-mods", message: "Mods client-only revisados.", current: 1, total: 1 });
  const minRam = normalizeRamLabel(body?.minRam) || "6G";
  const maxRam = normalizeRamLabel(body?.maxRam) || "12G";
  writeFileSync(join(targetPath, "eula.txt"), "# Accepted by Minecraft Control Center conversion\neula=true\n");
  writeFileSync(join(targetPath, "variables.txt"), `JAVA_ARGS="-Xmx${maxRam} -Xms${minRam}"\n`);
  writeFileSync(join(targetPath, "start.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "cd \"$(dirname \"$0\")\"",
    "source ./variables.txt",
    "exec ./run.sh nogui",
    ""
  ].join("\n"));
  spawnSync("chmod", ["+x", join(targetPath, "start.sh")]);

  const report = {
    source: sourcePath,
    minecraft: summary.minecraftVersion,
    loader: summary.modLoader,
    downloaded: downloaded.length,
    skipped: skipped.length,
    failed,
    skippedFiles: skipped,
    disabledClientMods
  };
  writeFileSync(join(targetPath, "conversion-report.json"), JSON.stringify(report, null, 2));

  return {
    path: targetPath,
    name,
    minRam,
    maxRam,
    notes: [
      `Convertido desde CurseForge export ${summary.name || name} ${summary.version || ""}`.trim(),
      `Mods descargados: ${downloaded.length}`,
      `Zips/recursos saltados: ${skipped.length}`,
      `Descargas fallidas: ${failed.length}`,
      disabledClientMods.length ? `Mods client-only desactivados: ${disabledClientMods.join(", ")}` : ""
    ].filter(Boolean).join("\n"),
    report
  };
}

function findStartScript(folder) {
  const candidates = ["start.sh", "run.sh", "server-start.sh", "startserver.sh"];
  return candidates.find((file) => existsSync(join(folder, file))) || "";
}

function findServerJar(folder) {
  const entries = readdirSync(folder);
  const jars = entries.filter((entry) => entry.toLowerCase().endsWith(".jar"));
  return (
    jars.find((entry) => /server|minecraft|forge|neoforge|fabric/i.test(entry)) ||
    jars[0] ||
    ""
  );
}

function detectRunnableServerPack(folder, values = {}) {
  const source = resolve(folder);
  const sourceStat = statSync(source);
  if (!sourceStat.isDirectory()) {
    throw new Error("La ruta importada debe ser una carpeta de servidor.");
  }

  const curseForge = curseForgeManifestInfo(source);
  if (curseForge) {
    throw new Error(
      `Ese paquete es un export de CurseForge (${curseForge.name || "sin nombre"} ${curseForge.version || ""}) con ${curseForge.files} mods. Aun necesita conversion antes de poder arrancar como servidor.`
    );
  }

  const script = findStartScript(source);
  const jar = findServerJar(source);
  if (!script && !jar) {
    throw new Error("No encontre start.sh/run.sh ni un .jar de servidor en la carpeta importada.");
  }

  const minRam = normalizeRamLabel(values.minRam) || "4G";
  const maxRam = normalizeRamLabel(values.maxRam) || "8G";
  const command = script
    ? `bash ${script}`
    : `java -Xms${minRam} -Xmx${maxRam} -jar ${shellQuote(jar)} nogui`;

  return {
    path: source,
    command,
    minRam,
    maxRam,
    detected: script ? `script:${script}` : `jar:${jar}`
  };
}

function ensureServerDefaults(folder, values) {
  const port = Number(values.port || 25565);
  const motd = String(values.name || basename(folder)).replace(/[=\r\n]/g, " ").trim();
  const variablesPath = join(folder, "variables.txt");
  const eulaPath = join(folder, "eula.txt");
  const propertiesPath = join(folder, "server.properties");

  if (!existsSync(eulaPath)) {
    writeFileSync(eulaPath, "# Accepted by Minecraft Control Center import\neula=true\n");
  }

  if (!existsSync(propertiesPath)) {
    writeFileSync(propertiesPath, [
      "# Generated by Minecraft Control Center",
      `server-port=${port}`,
      `motd=${motd || "Minecraft Control Center"}`,
      "online-mode=true",
      "white-list=false",
      "enable-command-block=false",
      ""
    ].join("\n"));
  }

  if (!existsSync(variablesPath)) {
    writeFileSync(variablesPath, `JAVA_ARGS="-Xmx${values.maxRam} -Xms${values.minRam}"\n`);
  }
}

function extractZip(sourcePath, targetPath) {
  const result = spawnSync("unzip", ["-q", sourcePath, "-d", targetPath], { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "No se pudo descomprimir el zip.").trim());
  }
}

function rootAfterExtraction(targetPath) {
  const entries = readdirSync(targetPath).filter((entry) => !entry.startsWith("__MACOSX"));
  if (entries.length === 1) {
    const only = join(targetPath, entries[0]);
    if (statSync(only).isDirectory()) {
      return only;
    }
  }
  return targetPath;
}

function importServerPack(config, body, progress = () => {}) {
  progress({ stage: "inspect", message: "Revisando pack seleccionado...", current: 0, total: 1 });
  const sourcePath = resolve(String(body?.sourcePath || "").trim());
  if (!sourcePath || !existsSync(sourcePath)) {
    throw new Error("La ruta del pack no existe.");
  }

  const sourceStat = statSync(sourcePath);
  let name = String(body?.name || "").trim() || basename(sourcePath).replace(/\.zip$/i, "");
  const requestedId = slugifyServerId(body?.id || name);
  if (requestedId && config.servers.some((server) => server.id === requestedId)) {
    throw new Error("Ya existe un servidor con ese id.");
  }
  const port = nextAvailablePort(config, body?.port || 25566);
  let serverPath = sourcePath;
  const notes = [];

  if (sourceStat.isFile()) {
    if (extname(sourcePath).toLowerCase() !== ".zip") {
      throw new Error("Por ahora solo puedo importar archivos .zip o carpetas.");
    }

    const curseForge = inspectZipForCurseForge(sourcePath);
    if (curseForge) {
      progress({ stage: "extract", message: "Descomprimiendo export de CurseForge...", current: 0, total: 1 });
      const exportPath = uniqueServerPath(`${name}-export`);
      mkdirSync(exportPath, { recursive: true });
      extractZip(sourcePath, exportPath);
      progress({ stage: "extract", message: "Export descomprimido.", current: 1, total: 1 });
      const converted = convertCurseForgeExport(sourcePath, config, body, rootAfterExtraction(exportPath), progress);
      serverPath = converted.path;
      name = converted.name;
      body = {
        ...body,
        name: converted.name,
        path: converted.path,
        minRam: converted.minRam,
        maxRam: converted.maxRam,
        notes: [String(body?.notes || "").trim(), converted.notes].filter(Boolean).join("\n")
      };
      notes.push(`Convertido desde zip CurseForge: ${sourcePath}`);
      notes.push(`Reporte: ${join(converted.path, "conversion-report.json")}`);
    } else {
      progress({ stage: "extract", message: "Descomprimiendo server pack...", current: 0, total: 1 });
      serverPath = uniqueServerPath(name);
      mkdirSync(serverPath, { recursive: true });
      extractZip(sourcePath, serverPath);
      serverPath = rootAfterExtraction(serverPath);
      progress({ stage: "extract", message: "Server pack descomprimido.", current: 1, total: 1 });
      notes.push(`Importado desde zip: ${sourcePath}`);
    }
  } else if (!sourceStat.isDirectory()) {
    throw new Error("La ruta del pack debe ser carpeta o archivo .zip.");
  }

  if (sourceStat.isDirectory() && curseForgeManifestInfo(serverPath)) {
    const converted = convertCurseForgeExport(sourcePath, config, body, "", progress);
    serverPath = converted.path;
    name = converted.name;
    body = {
      ...body,
      name: converted.name,
      path: converted.path,
      minRam: converted.minRam,
      maxRam: converted.maxRam,
      notes: [String(body?.notes || "").trim(), converted.notes].filter(Boolean).join("\n")
    };
    notes.push(`Convertido desde carpeta CurseForge: ${sourcePath}`);
    notes.push(`Reporte: ${join(converted.path, "conversion-report.json")}`);
  }

  progress({ stage: "detect", message: "Detectando comando de arranque...", current: 0, total: 1 });
  const detected = detectRunnableServerPack(serverPath, {
    minRam: body?.minRam,
    maxRam: body?.maxRam
  });

  const server = createServerRecord(config, {
    ...body,
    name,
    id: body?.id || name,
    path: detected.path,
    command:
      body?.command && body.command !== "bash start.sh"
        ? body.command
        : detected.command,
    port,
    minRam: detected.minRam,
    maxRam: detected.maxRam,
    notes: [String(body?.notes || "").trim(), ...notes, `Detectado: ${detected.detected}`]
      .filter(Boolean)
      .join("\n")
  });

  progress({ stage: "register", message: "Generando defaults y registrando instancia...", current: 0, total: 1 });
  ensureServerDefaults(server.path, server);
  config.servers.push(server);
  saveConfig(config);
  startLogWatcher(server);
  reconcileScreenStates();
  progress({ stage: "register", message: "Instancia registrada.", current: 1, total: 1 });

  return {
    ok: true,
    server: publicServer(server),
    detected: detected.detected,
    notes
  };
}

function readStdinJson() {
  return new Promise((resolvePromise, rejectPromise) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => {
      try {
        resolvePromise(raw ? JSON.parse(raw) : {});
      } catch (error) {
        rejectPromise(error);
      }
    });
    process.stdin.on("error", rejectPromise);
  });
}

function writeWorkerMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function runImportWorker() {
  const body = await readStdinJson();
  const config = loadConfig();
  const result = importServerPack(config, body, (progress) => {
    writeWorkerMessage({ type: "progress", progress });
  });
  writeWorkerMessage({ type: "done", result });
}

function createImportJob(body) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
    status: "running",
    message: "Iniciando importacion...",
    stage: "starting",
    current: 0,
    total: 1,
    percent: 0,
    result: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    process: null
  };

  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "--import-worker"], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"]
  });
  job.process = child;
  importJobs.set(id, job);

  let stdoutBuffer = "";
  let stderrBuffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      try {
        const message = JSON.parse(line);
        if (message.type === "progress") {
          updateImportJobProgress(job, message.progress);
        }
        if (message.type === "done") {
          job.status = "complete";
          job.result = message.result;
          job.message = "Importacion completada.";
          job.stage = "complete";
          job.current = 1;
          job.total = 1;
          job.percent = 100;
          job.updatedAt = new Date().toISOString();
        }
        if (message.type === "error") {
          job.status = "failed";
          job.error = message.error || "La importacion fallo.";
          job.message = job.error;
          job.updatedAt = new Date().toISOString();
        }
      } catch {
        stderrBuffer += `${line}\n`;
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk;
  });

  child.on("close", (code, signal) => {
    job.process = null;
    if (job.status === "complete" || job.status === "cancelled" || job.status === "failed") {
      return;
    }

    job.status = "failed";
    job.error = signal === "SIGTERM"
      ? "Importacion cancelada."
      : (stderrBuffer.trim() || `La importacion fallo con codigo ${code}.`);
    job.message = job.error;
    job.updatedAt = new Date().toISOString();
  });

  child.stdin.end(JSON.stringify(body));
  return serializeImportJob(job);
}

function updateImportJobProgress(job, progress = {}) {
  const total = Number(progress.total || 1);
  const current = Number(progress.current || 0);

  job.stage = progress.stage || job.stage;
  job.message = progress.message || job.message;
  job.current = current;
  job.total = total;
  job.percent = total > 0 ? Math.max(0, Math.min(100, Math.round((current / total) * 100))) : 0;
  job.updatedAt = new Date().toISOString();
}

function serializeImportJob(job) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    message: job.message,
    current: job.current,
    total: job.total,
    percent: job.percent,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

function findImportJob(id) {
  const job = importJobs.get(id);
  if (!job) {
    throw new Error("Trabajo de importacion no encontrado.");
  }
  return job;
}

function cancelImportJob(id) {
  const job = findImportJob(id);
  if (job.status !== "running") {
    return serializeImportJob(job);
  }

  job.status = "cancelled";
  job.message = "Importacion cancelada.";
  job.error = "Importacion cancelada.";
  job.updatedAt = new Date().toISOString();

  if (job.process) {
    job.process.kill("SIGTERM");
  }

  return serializeImportJob(job);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function screenSessionName(server) {
  return `mc-${server.id}`;
}

function listScreenSessions() {
  const result = spawnSync("screen", ["-ls"], { encoding: "utf8" });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const sessions = new Map();

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\.([^\s]+)\s+\(/);
    if (match) {
      sessions.set(match[2], { pid: Number(match[1]), name: match[2] });
    }
  }

  return sessions;
}

function screenInfo(server) {
  return listScreenSessions().get(screenSessionName(server)) || null;
}

function isScreenRunning(server) {
  return Boolean(screenInfo(server));
}

function runScreen(args) {
  const result = spawnSync("screen", args, { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "screen command failed").trim());
  }
  return result;
}

function readProcessInfo(pid) {
  try {
    const statRaw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeIndex = statRaw.lastIndexOf(")");
    const name = statRaw.slice(statRaw.indexOf("(") + 1, closeIndex);
    const fields = statRaw.slice(closeIndex + 2).trim().split(/\s+/);
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    return {
      pid: Number(pid),
      name,
      ppid: Number(fields[1]),
      ticks: Number(fields[11]) + Number(fields[12]),
      rssBytes: Number(fields[21]) * PAGE_SIZE,
      cmdline
    };
  } catch {
    return null;
  }
}

function listProcesses() {
  return readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .map(readProcessInfo)
    .filter(Boolean);
}

function collectDescendants(rootPid) {
  const processes = listProcesses();
  const children = new Map();
  for (const process of processes) {
    const group = children.get(process.ppid) || [];
    group.push(process);
    children.set(process.ppid, group);
  }

  const descendants = [];
  const queue = [...(children.get(rootPid) || [])];
  while (queue.length) {
    const process = queue.shift();
    descendants.push(process);
    queue.push(...(children.get(process.pid) || []));
  }
  return descendants;
}

function measureProcessUsage(server, screenPid) {
  if (!screenPid) {
    usageSamples.delete(server.id);
    return null;
  }

  const descendants = collectDescendants(screenPid);
  const javaProcess = descendants.find((process) => /\bjava\b/.test(process.cmdline || process.name));
  const measured = descendants.length ? descendants : [readProcessInfo(screenPid)].filter(Boolean);
  const ticks = measured.reduce((total, process) => total + process.ticks, 0);
  const rssBytes = measured.reduce((total, process) => total + process.rssBytes, 0);
  const now = Date.now();
  const previous = usageSamples.get(server.id);
  let cpuPercent = 0;

  if (previous && now > previous.at && ticks >= previous.ticks) {
    const elapsedSeconds = (now - previous.at) / 1000;
    cpuPercent = ((ticks - previous.ticks) / CLOCK_TICKS_PER_SECOND / elapsedSeconds) * 100;
  }

  usageSamples.set(server.id, { at: now, ticks });
  return {
    processPid: javaProcess?.pid || measured[0]?.pid || screenPid,
    processName: javaProcess ? "java" : measured[0]?.name || "screen",
    processCount: measured.length,
    cpuPercent: Number(cpuPercent.toFixed(1)),
    rssMb: Number((rssBytes / 1024 / 1024).toFixed(1))
  };
}

function findServer(id) {
  return loadConfig().servers.find((server) => server.id === id);
}

function publicServer(server) {
  const info = screenInfo(server);
  const running = Boolean(info);
  const logs = logBuffers.get(server.id) || [];
  const usage = running ? measureProcessUsage(server, info.pid) : null;
  return {
    ...server,
    running,
    pid: running ? info.pid : null,
    supervisor: "screen",
    session: screenSessionName(server),
    usage,
    logFile: latestLogFile(server),
    recentLogs: logs.slice(-80),
    players: publicPlayers(server)
  };
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function broadcast(type, payload = {}) {
  const message = JSON.stringify({ type, payload, at: new Date().toISOString() });
  for (const client of clients) {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  }
}

function appendLog(serverId, line, stream = "system") {
  const item = { stream, line: String(line).replace(/\r?\n$/, ""), at: new Date().toISOString() };
  const buffer = logBuffers.get(serverId) || [];
  buffer.push(item);
  if (buffer.length > 800) {
    buffer.splice(0, buffer.length - 800);
  }
  logBuffers.set(serverId, buffer);
  updatePlayersFromLog(serverId, item.line);
  broadcast("log", { serverId, ...item });
}

function notifyServer(server, event, message, details = {}) {
  if (!server.notifyWebhookUrl) {
    return;
  }

  const payload = {
    event,
    serverId: server.id,
    serverName: server.name,
    message,
    at: new Date().toISOString(),
    details
  };

  fetch(server.notifyWebhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  }).catch((error) => {
    appendLog(server.id, `Notification failed: ${error.message}`, "error");
  });
}

function latestLogFile(server) {
  return join(resolve(server.path), "logs", "latest.log");
}

function readRecentLogEntries(server, count = 200) {
  const file = latestLogFile(server);
  if (!existsSync(file)) {
    return [];
  }

  const now = new Date().toISOString();
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-count)
    .map((line) => ({ stream: "stdout", line, at: now }));
}

function reloadLogBuffer(server, count = 200) {
  const entries = readRecentLogEntries(server, count);
  logBuffers.set(server.id, entries);
  playerState.set(server.id, new Map());
  for (const entry of entries) {
    updatePlayersFromLog(server.id, entry.line);
  }
  return { file: latestLogFile(server), entries };
}

function seedLogBuffer(server) {
  if (!logBuffers.has(server.id)) {
    reloadLogBuffer(server);
  }
}

function readLogPosition(server) {
  const file = latestLogFile(server);
  if (!existsSync(file)) {
    return 0;
  }
  return statSync(file).size;
}

function pollLatestLog(server) {
  const watcher = logWatchers.get(server.id);
  if (!watcher) {
    return;
  }

  const file = latestLogFile(server);
  if (!existsSync(file)) {
    watcher.position = 0;
    return;
  }

  const buffer = readFileSync(file);
  if (buffer.length < watcher.position) {
    watcher.position = 0;
  }
  if (buffer.length === watcher.position) {
    return;
  }

  const chunk = buffer.subarray(watcher.position).toString("utf8");
  watcher.position = buffer.length;
  for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
    appendLog(server.id, line, "stdout");
  }
}

function startLogWatcher(server, options = {}) {
  seedLogBuffer(server);
  if (logWatchers.has(server.id)) {
    return;
  }

  const watcher = {
    position: options.fromStart ? 0 : readLogPosition(server),
    timer: null
  };
  watcher.timer = setInterval(() => pollLatestLog(server), 1500);
  watcher.timer.unref();
  logWatchers.set(server.id, watcher);
}

function stopLogWatcher(serverId) {
  const watcher = logWatchers.get(serverId);
  if (!watcher) {
    return;
  }

  clearInterval(watcher.timer);
  logWatchers.delete(serverId);
}

function startAllLogWatchers() {
  for (const server of loadConfig().servers) {
    startLogWatcher(server);
  }
}

function reconcileScreenStates() {
  for (const server of loadConfig().servers) {
    const info = screenInfo(server);
    const running = Boolean(info);
    const previous = screenStates.get(server.id);
    if (!previous || previous.running !== running || previous.pid !== (info?.pid || null)) {
      screenStates.set(server.id, { running, pid: info?.pid || null });
      if (!running && previous?.running) {
        playerState.set(server.id, new Map());
        if (!manualStops.has(server.id)) {
          appendLog(server.id, "screen session ended.", "system");
          notifyServer(server, "server_stopped_unexpectedly", "La sesion screen del servidor termino inesperadamente.", {
            session: screenSessionName(server),
            previousPid: previous.pid || null
          });
          scheduleAutoRestart(server);
        }
        broadcastPlayers(server.id);
      }
      broadcast("server-state", {
        serverId: server.id,
        running,
        pid: info?.pid || null,
        usage: running ? measureProcessUsage(server, info?.pid || null) : null
      });
    } else if (running) {
      broadcast("server-state", {
        serverId: server.id,
        running,
        pid: info?.pid || null,
        usage: measureProcessUsage(server, info?.pid || null)
      });
    }
  }
}

function startScreenMonitor() {
  reconcileScreenStates();
  const timer = setInterval(reconcileScreenStates, 3000);
  timer.unref();
}

function rememberRestartAttempt(server) {
  const now = Date.now();
  const recent = (restartAttempts.get(server.id) || []).filter((at) => now - at < RESTART_WINDOW_MS);
  if (recent.length >= MAX_RESTARTS_IN_WINDOW) {
    restartAttempts.set(server.id, recent);
    return false;
  }
  recent.push(now);
  restartAttempts.set(server.id, recent);
  return true;
}

function scheduleAutoRestart(server) {
  if (!server.autoRestart || scheduledRestarts.has(server.id)) {
    return;
  }
  if (!rememberRestartAttempt(server)) {
    appendLog(server.id, "Auto-restart skipped: retry limit reached.", "system");
    notifyServer(server, "server_auto_restart_limited", "Auto-restart detenido por limite de reintentos.", {
      maxRestarts: MAX_RESTARTS_IN_WINDOW,
      windowMs: RESTART_WINDOW_MS
    });
    return;
  }

  scheduledRestarts.add(server.id);
  appendLog(server.id, "Auto-restart scheduled in 10 seconds.", "system");
  notifyServer(server, "server_auto_restart_scheduled", "Auto-restart programado tras una caida.", {
    delayMs: RESTART_DELAY_MS
  });
  setTimeout(() => {
    scheduledRestarts.delete(server.id);
    const current = findServer(server.id);
    if (current && !isScreenRunning(current)) {
      try {
        startServer(current);
      } catch (error) {
        appendLog(server.id, `Auto-restart failed: ${error.message}`, "error");
        notifyServer(current, "server_auto_restart_failed", "Auto-restart fallo.", {
          error: error.message
        });
      }
    }
  }, RESTART_DELAY_MS).unref();
}

function cronFieldMatches(field, value, min, max) {
  return field.split(",").some((part) => {
    const item = part.trim();
    if (!item) {
      return false;
    }
    if (item === "*") {
      return true;
    }
    if (item.startsWith("*/")) {
      const step = Number(item.slice(2));
      return Number.isInteger(step) && step > 0 && (value - min) % step === 0;
    }
    const rangeMatch = item.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      return value >= Math.max(min, start) && value <= Math.min(max, end);
    }
    const number = Number(item);
    return Number.isInteger(number) && number >= min && number <= max && value === number;
  });
}

function cronMatches(schedule, date) {
  const fields = validateCronSchedule(schedule).split(/\s+/);
  return (
    cronFieldMatches(fields[0], date.getMinutes(), 0, 59) &&
    cronFieldMatches(fields[1], date.getHours(), 0, 23) &&
    cronFieldMatches(fields[2], date.getDate(), 1, 31) &&
    cronFieldMatches(fields[3], date.getMonth() + 1, 1, 12) &&
    cronFieldMatches(fields[4], date.getDay(), 0, 6)
  );
}

function backupRunKey(server, date) {
  const minuteKey = [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes()
  ].join("-");
  return `${server.id}:${server.backupSchedule}:${minuteKey}`;
}

function runScheduledBackups() {
  const now = new Date();
  for (const server of loadConfig().servers) {
    if (!server.backupSchedule || runningBackups.has(server.id)) {
      continue;
    }

    let matches = false;
    try {
      matches = cronMatches(server.backupSchedule, now);
    } catch (error) {
      appendLog(server.id, `Backup schedule ignored: ${error.message}`, "error");
      continue;
    }

    const key = backupRunKey(server, now);
    if (!matches || lastBackupRuns.get(server.id) === key) {
      continue;
    }

    lastBackupRuns.set(server.id, key);
    runningBackups.add(server.id);
    appendLog(server.id, `Scheduled backup started: ${server.backupSchedule}`, "system");
    createBackup(server)
      .then((result) => appendLog(server.id, `Scheduled backup finished: ${result.path}`, "system"))
      .catch((error) => {
        appendLog(server.id, `Scheduled backup failed: ${error.message}`, "error");
        notifyServer(server, "scheduled_backup_failed", "Backup programado fallo.", {
          schedule: server.backupSchedule,
          error: error.message
        });
      })
      .finally(() => runningBackups.delete(server.id));
  }
}

function startBackupScheduler() {
  runScheduledBackups();
  const timer = setInterval(runScheduledBackups, 60 * 1000);
  timer.unref();
}

function cleanPlayerName(name) {
  const cleaned = String(name || "").replace(/§./g, "").trim();
  return /^[A-Za-z0-9_]{3,16}$/.test(cleaned) ? cleaned : "";
}

function readOps(server) {
  const file = join(resolve(server.path), "ops.json");
  if (!existsSync(file)) {
    return new Set();
  }

  try {
    const entries = JSON.parse(readFileSync(file, "utf8"));
    return new Set(entries.map((entry) => cleanPlayerName(entry.name)).filter(Boolean));
  } catch {
    return new Set();
  }
}

function publicPlayers(server) {
  const players = playerState.get(server.id) || new Map();
  const ops = readOps(server);
  return [...players.values()]
    .filter((player) => player.online)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((player) => ({
      ...player,
      op: ops.has(player.name)
    }));
}

function broadcastPlayers(serverId) {
  const server = findServer(serverId);
  if (server) {
    broadcast("players", { serverId, players: publicPlayers(server) });
  }
}

function markPlayer(serverId, name, online) {
  const cleanName = cleanPlayerName(name);
  if (!cleanName) {
    return false;
  }

  const players = playerState.get(serverId) || new Map();
  const previous = players.get(cleanName);
  players.set(cleanName, {
    name: cleanName,
    online,
    seenAt: new Date().toISOString()
  });
  playerState.set(serverId, players);
  return !previous || previous.online !== online;
}

function replaceOnlinePlayers(serverId, names) {
  const cleanNames = names.map(cleanPlayerName).filter(Boolean);
  const players = new Map();
  for (const name of cleanNames) {
    players.set(name, {
      name,
      online: true,
      seenAt: new Date().toISOString()
    });
  }
  playerState.set(serverId, players);
  return true;
}

function updatePlayersFromLog(serverId, line) {
  const cleanLine = String(line).replace(/§./g, "");
  const listMatch = cleanLine.match(/There are \d+ of a max of \d+ players online:\s*(.*)$/i);
  if (listMatch) {
    const names = listMatch[1] ? listMatch[1].split(",").map((name) => name.trim()) : [];
    replaceOnlinePlayers(serverId, names);
    broadcastPlayers(serverId);
    return;
  }

  const joinedMatch = cleanLine.match(/\b([A-Za-z0-9_]{3,16}) joined the game\b/);
  if (joinedMatch && markPlayer(serverId, joinedMatch[1], true)) {
    broadcastPlayers(serverId);
    return;
  }

  const leftMatch = cleanLine.match(/\b([A-Za-z0-9_]{3,16}) (left the game|lost connection)\b/);
  if (leftMatch && markPlayer(serverId, leftMatch[1], false)) {
    broadcastPlayers(serverId);
  }
}

async function playerAction(server, action, playerName) {
  const name = cleanPlayerName(playerName);
  if (!name && action !== "refresh") {
    throw new Error("Nombre de jugador invalido.");
  }

  const commands = {
    refresh: "list",
    kick: `kick ${name} Expulsado desde panel`,
    ban: `ban ${name} Baneado desde panel`,
    kill: `kill ${name}`,
    op: `op ${name}`,
    deop: `deop ${name}`,
    whitelist: `whitelist add ${name}`
  };
  const command = commands[action];
  if (!command) {
    throw new Error("Accion de jugador no soportada.");
  }

  await sendCommand(server, command);
  if (action === "kick" || action === "ban") {
    markPlayer(server.id, name, false);
    broadcastPlayers(server.id);
  }
  return { ok: true, players: publicPlayers(server) };
}

function parseCommandLine(commandLine) {
  const parts = commandLine.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  return parts.map((part) => part.replace(/^"|"$/g, ""));
}

function startServer(server) {
  const existing = screenInfo(server);
  if (existing) {
    startLogWatcher(server);
    return { ok: true, alreadyRunning: true, pid: existing.pid, session: screenSessionName(server) };
  }

  if (!existsSync(server.path)) {
    throw new Error(`La carpeta no existe: ${server.path}`);
  }

  const [command] = parseCommandLine(server.command);
  if (!command) {
    throw new Error("El comando de arranque esta vacio.");
  }

  const session = screenSessionName(server);
  const launchCommand = `cd ${shellQuote(resolve(server.path))} && exec ${server.command}`;
  appendLog(server.id, `Starting screen session ${session}: ${server.command}`, "system");
  playerState.set(server.id, new Map());
  startLogWatcher(server);

  runScreen(["-dmS", session, "bash", "-lc", launchCommand]);

  const info = screenInfo(server);
  broadcast("server-state", {
    serverId: server.id,
    running: true,
    pid: info?.pid || null,
    usage: info ? measureProcessUsage(server, info.pid) : null
  });
  broadcastPlayers(server.id);
  return { ok: true, pid: info?.pid || null, session };
}

async function sendCommand(server, command) {
  if (!isScreenRunning(server)) {
    throw new Error("El servidor no esta corriendo en screen.");
  }

  let result = "";
  if (rconSettings(server).available) {
    result = await sendRconCommand(server, command);
  } else {
    runScreen(["-S", screenSessionName(server), "-X", "stuff", `${command}\n`]);
  }

  appendLog(server.id, `> ${command}`, "command");
  return { ok: true, result };
}

async function stopServer(server, options = {}) {
  if (!isScreenRunning(server)) {
    return { ok: true, alreadyStopped: true };
  }

  manualStops.add(server.id);
  if (rconSettings(server).available) {
    await sendRconCommand(server, "stop");
  } else {
    runScreen(["-S", screenSessionName(server), "-X", "stuff", "stop\n"]);
  }
  appendLog(server.id, "> stop", "command");
  setTimeout(() => {
    if (isScreenRunning(server)) {
      runScreen(["-S", screenSessionName(server), "-X", "quit"]);
      appendLog(server.id, "screen session closed after graceful stop timeout.", "system");
    }
    if (!options.keepManualStop) {
      manualStops.delete(server.id);
    }
    broadcast("server-state", { serverId: server.id, running: false, pid: null, usage: null });
    broadcastPlayers(server.id);
  }, 20000).unref();
  return { ok: true };
}

function propertiesFile(server) {
  return join(resolve(server.path), "server.properties");
}

function variablesFile(server) {
  return join(resolve(server.path), "variables.txt");
}

function systemMemoryInfo() {
  const totalGb = totalmem() / 1024 ** 3;
  const availableGb = freemem() / 1024 ** 3;
  const maxAllowedGb = Math.max(2, Math.floor(totalGb * 0.72));
  const recommendedMaxGb = Math.min(12, Math.max(4, Math.floor(totalGb * 0.55)));
  const recommendedMinGb = Math.min(6, Math.max(2, Math.floor(recommendedMaxGb / 2)));
  return {
    totalGb: Number(totalGb.toFixed(1)),
    availableGb: Number(availableGb.toFixed(1)),
    maxAllowedGb,
    recommendedMinGb,
    recommendedMaxGb
  };
}

function parseJavaArgs(raw) {
  const match = raw.match(/^JAVA_ARGS=(?:"([^"]*)"|'([^']*)'|(.+))$/m);
  const value = match ? (match[1] ?? match[2] ?? match[3] ?? "").trim() : "";
  const minMatch = value.match(/(?:^|\s)-Xms(\d+)([GgMm])(?:\s|$)/);
  const maxMatch = value.match(/(?:^|\s)-Xmx(\d+)([GgMm])(?:\s|$)/);
  return {
    value,
    minRam: minMatch ? `${minMatch[1]}${minMatch[2].toUpperCase()}` : "",
    maxRam: maxMatch ? `${maxMatch[1]}${maxMatch[2].toUpperCase()}` : ""
  };
}

function readServerRam(server) {
  const file = variablesFile(server);
  const memory = systemMemoryInfo();
  if (!existsSync(file)) {
    return {
      file,
      memory,
      javaArgs: "",
      minRam: server.minRam || "",
      maxRam: server.maxRam || ""
    };
  }

  const raw = readFileSync(file, "utf8");
  const parsed = parseJavaArgs(raw);
  return {
    file,
    memory,
    javaArgs: parsed.value,
    minRam: parsed.minRam || server.minRam || "",
    maxRam: parsed.maxRam || server.maxRam || ""
  };
}

function ramLabelToGb(value) {
  const match = String(value || "").trim().match(/^(\d+)(G|M)?$/i);
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  const unit = (match[2] || "G").toUpperCase();
  return unit === "M" ? amount / 1024 : amount;
}

function replaceJavaArgs(raw, minRam, maxRam) {
  const current = parseJavaArgs(raw).value;
  const extraArgs = current
    .replace(/(?:^|\s)-Xms\d+[GgMm](?=\s|$)/g, " ")
    .replace(/(?:^|\s)-Xmx\d+[GgMm](?=\s|$)/g, " ")
    .trim();
  const nextValue = [`-Xmx${maxRam}`, `-Xms${minRam}`, extraArgs].filter(Boolean).join(" ");
  const nextLine = `JAVA_ARGS="${nextValue}"`;

  if (/^JAVA_ARGS=/m.test(raw)) {
    return raw.replace(/^JAVA_ARGS=.*$/m, nextLine);
  }

  return `${raw.replace(/\n*$/, "\n")}${nextLine}\n`;
}

function updateServerRam(server, values) {
  const file = variablesFile(server);
  if (!existsSync(file)) {
    throw new Error(`No existe variables.txt en: ${server.path}`);
  }

  const minRam = `${Number(values?.minGb)}G`;
  const maxRam = `${Number(values?.maxGb)}G`;
  const minGb = ramLabelToGb(minRam);
  const maxGb = ramLabelToGb(maxRam);
  const memory = systemMemoryInfo();

  if (!Number.isFinite(minGb) || !Number.isFinite(maxGb) || minGb < 1 || maxGb < 1) {
    throw new Error("La RAM debe ser un numero positivo en GB.");
  }
  if (minGb > maxGb) {
    throw new Error("La RAM minima no puede ser mayor que la maxima.");
  }
  if (maxGb > memory.maxAllowedGb) {
    throw new Error(`Para esta laptop el limite recomendado del panel es ${memory.maxAllowedGb}G.`);
  }

  const raw = readFileSync(file, "utf8");
  writeFileSync(file, replaceJavaArgs(raw, minRam, maxRam));
  const updatedServer = saveServerRecord(server.id, { minRam, maxRam });
  appendLog(server.id, `RAM updated: ${minRam} / ${maxRam}. Restart required.`, "system");
  return { ...readServerRam(updatedServer), server: publicServer(updatedServer) };
}

function parseProperties(raw) {
  const values = {};
  const lines = raw.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return { type: "raw", raw: line };
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      return { type: "raw", raw: line };
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1);
    values[key] = value;
    return { type: "property", key, value, raw: line };
  });
  return { lines, values };
}

function readRawServerProperties(server) {
  const file = propertiesFile(server);
  if (!existsSync(file)) {
    return null;
  }

  return parseProperties(readFileSync(file, "utf8")).values;
}

function rconSettings(server) {
  const properties = readRawServerProperties(server) || {};
  const password = String(server.rconPassword || properties["rcon.password"] || "").trim();
  const enabled = String(properties["enable-rcon"] || "").trim().toLowerCase() === "true";
  const port = Number(server.rconPort || properties["rcon.port"] || 25575);
  const host = String(server.rconHost || RCON_DEFAULT_HOST).trim() || RCON_DEFAULT_HOST;

  return {
    enabled,
    host,
    port,
    password,
    available: enabled && password && Number.isInteger(port) && port > 0 && port <= 65535
  };
}

function encodeRconPacket(id, type, payload = "") {
  const bodyLength = Buffer.byteLength(payload) + 10;
  const packet = Buffer.alloc(bodyLength + 4);

  packet.writeInt32LE(bodyLength, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  packet.write(payload, 12, "utf8");

  return packet;
}

function readRconPacket(socket, timeoutMs = RCON_TIMEOUT_MS) {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      cleanup();
      rejectPromise(new Error("Tiempo agotado esperando respuesta RCON."));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };

    const onError = (error) => {
      cleanup();
      rejectPromise(error);
    };

    const onClose = () => {
      cleanup();
      rejectPromise(new Error("Conexion RCON cerrada antes de responder."));
    };

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) {
        return;
      }

      const length = buffer.readInt32LE(0);
      if (buffer.length < length + 4) {
        return;
      }

      cleanup();
      resolvePromise({
        id: buffer.readInt32LE(4),
        type: buffer.readInt32LE(8),
        payload: buffer.subarray(12, 4 + length - 2).toString("utf8")
      });
    };

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

async function sendRconCommand(server, command) {
  const settings = rconSettings(server);
  if (!settings.available) {
    throw new Error("RCON no esta configurado para esta instancia.");
  }

  const socket = connect({
    host: settings.host,
    port: settings.port
  });

  try {
    await new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        socket.destroy();
        rejectPromise(new Error("Tiempo agotado conectando a RCON."));
      }, RCON_TIMEOUT_MS);

      socket.once("connect", () => {
        clearTimeout(timeout);
        resolvePromise();
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        rejectPromise(error);
      });
    });

    const authId = rconRequestId++;
    socket.write(encodeRconPacket(authId, 3, settings.password));
    const auth = await readRconPacket(socket);
    if (auth.id === -1) {
      throw new Error("Autenticacion RCON rechazada.");
    }

    const commandId = rconRequestId++;
    socket.write(encodeRconPacket(commandId, 2, command));
    const response = await readRconPacket(socket);
    return response.payload;
  } finally {
    socket.end();
  }
}

function readServerProperties(server) {
  const file = propertiesFile(server);
  if (!existsSync(file)) {
    throw new Error(`No existe server.properties en: ${server.path}`);
  }

  const raw = readFileSync(file, "utf8");
  const parsed = parseProperties(raw);
  return {
    file,
    fields: PROPERTY_FIELDS.map((field) => ({
      ...field,
      value: parsed.values[field.key] ?? ""
    }))
  };
}

function updateServerProperties(server, updates) {
  const file = propertiesFile(server);
  if (!existsSync(file)) {
    throw new Error(`No existe server.properties en: ${server.path}`);
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(updates || {})) {
    if (PROPERTY_KEYS.has(key)) {
      sanitized[key] = String(value).replace(/\r?\n/g, " ").trim();
    }
  }

  const raw = readFileSync(file, "utf8");
  const parsed = parseProperties(raw);
  const seen = new Set();
  const nextLines = parsed.lines.map((line) => {
    if (line.type !== "property" || !(line.key in sanitized)) {
      return line.raw;
    }

    seen.add(line.key);
    return `${line.key}=${sanitized[line.key]}`;
  });

  const missing = Object.keys(sanitized).filter((key) => !seen.has(key));
  if (missing.length) {
    nextLines.push("# Added by Minecraft Control Center");
    for (const key of missing) {
      nextLines.push(`${key}=${sanitized[key]}`);
    }
  }

  writeFileSync(file, `${nextLines.join("\n").replace(/\n+$/, "")}\n`);
  appendLog(server.id, "server.properties updated. Restart required for most changes.", "system");
  return readServerProperties(server);
}

async function createBackup(server) {
  const source = resolve(server.path);
  const targetRoot = join(BACKUP_DIR, server.id);
  mkdirSync(targetRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = join(targetRoot, `${server.id}-${stamp}`);

  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new Error(`No existe la carpeta del servidor: ${source}`);
  }

  await cp(source, target, {
    recursive: true,
    filter: (path) => {
      const normalized = path.replaceAll("\\", "/");
      return !normalized.includes("/logs/") && !normalized.includes("/crash-reports/");
    }
  });

  appendLog(server.id, `Backup created: ${target}`, "system");
  return { ok: true, path: target };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const safePath = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = safePath === "/" ? join(PUBLIC_DIR, "index.html") : join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml"
  };
  response.writeHead(200, { "content-type": types[extname(filePath)] || "application/octet-stream" });
  createReadStream(filePath).pipe(response);
}

function resolveServerFile(server, requestedPath = "") {
  const root = resolve(server.path);
  const target = resolve(root, String(requestedPath || "."));
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error("Ruta fuera de la carpeta del servidor.");
  }
  return { root, target, relativePath: relative(root, target) };
}

async function getDirectorySummary(server, requestedPath = "") {
  const { root, target, relativePath } = resolveServerFile(server, requestedPath);
  const targetStat = statSync(target);
  if (!targetStat.isDirectory()) {
    throw new Error("La ruta no es una carpeta.");
  }

  const entries = await readdir(target);
  const summary = [];
  for (const entry of entries.slice(0, 200)) {
    const fullPath = join(target, entry);
    const itemStat = await stat(fullPath);
    summary.push({
      name: entry,
      path: relative(root, fullPath),
      directory: itemStat.isDirectory(),
      size: itemStat.size
    });
  }
  summary.sort((left, right) => Number(right.directory) - Number(left.directory) || left.name.localeCompare(right.name));
  return { path: relativePath, entries: summary };
}

function assertTextFile(buffer) {
  if (buffer.includes(0)) {
    throw new Error("El archivo parece binario.");
  }
}

function readTextFile(server, requestedPath = "") {
  const { target, relativePath } = resolveServerFile(server, requestedPath);
  const fileStat = statSync(target);
  if (!fileStat.isFile()) {
    throw new Error("La ruta no es un archivo.");
  }
  if (fileStat.size > 1024 * 1024) {
    throw new Error("Solo se pueden abrir archivos de texto menores a 1MB.");
  }

  const buffer = readFileSync(target);
  assertTextFile(buffer);
  return {
    path: relativePath,
    name: basename(target),
    size: fileStat.size,
    content: buffer.toString("utf8")
  };
}

function writeTextFile(server, requestedPath = "", content = "") {
  const { target } = resolveServerFile(server, requestedPath);
  const fileStat = statSync(target);
  if (!fileStat.isFile()) {
    throw new Error("La ruta no es un archivo.");
  }
  if (Buffer.byteLength(String(content), "utf8") > 1024 * 1024) {
    throw new Error("Solo se pueden guardar archivos menores a 1MB.");
  }

  writeFileSync(target, String(content));
  appendLog(server.id, `File updated: ${requestedPath}`, "system");
  return readTextFile(server, requestedPath);
}

function sendDownload(server, requestedPath, response) {
  const { target } = resolveServerFile(server, requestedPath);
  const fileStat = statSync(target);
  if (!fileStat.isFile()) {
    throw new Error("La ruta no es un archivo.");
  }

  response.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": fileStat.size,
    "content-disposition": `attachment; filename="${basename(target).replaceAll('"', "")}"`
  });
  createReadStream(target).pipe(response);
}

async function handleApi(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const segments = url.pathname.split("/").filter(Boolean);
  const config = loadConfig();

  if (request.method === "GET" && url.pathname === "/api/state") {
    sendJson(response, 200, {
      servers: config.servers.map(publicServer),
      commands: COMMANDS,
      memory: systemMemoryInfo()
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/commands") {
    const query = url.searchParams.get("q") || "";
    sendJson(response, 200, completeCommand(query));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/servers") {
    const body = await readBody(request);
    const server = createServerRecord(config, body);
    config.servers.push(server);
    saveConfig(config);
    startLogWatcher(server);
    reconcileScreenStates();
    sendJson(response, 201, publicServer(server));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/import-server") {
    const body = await readBody(request);
    sendJson(response, 202, { job: createImportJob(body) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/import-browser") {
    sendJson(response, 200, importBrowserSummary(url.searchParams.get("path") || ""));
    return;
  }

  if (segments[0] === "api" && segments[1] === "import-jobs" && segments[2]) {
    if (request.method === "GET" && !segments[3]) {
      sendJson(response, 200, { job: serializeImportJob(findImportJob(segments[2])) });
      return;
    }

    if (request.method === "POST" && segments[3] === "cancel") {
      sendJson(response, 200, { job: cancelImportJob(segments[2]) });
      return;
    }
  }

  if (segments[0] === "api" && segments[1] === "servers" && segments[2]) {
    const server = findServer(segments[2]);
    if (!server) {
      sendJson(response, 404, { error: "Servidor no encontrado." });
      return;
    }

    if (request.method === "DELETE" && !segments[3]) {
      if (isScreenRunning(server)) {
        sendJson(response, 409, { error: "Deten la instancia antes de quitarla del panel." });
        return;
      }

      sendJson(response, 200, { ok: true, server: publicServer(deleteServerRecord(server.id)) });
      return;
    }

    const action = segments[3];
    if (request.method === "POST" && action === "start") {
      sendJson(response, 200, startServer(server));
      return;
    }
    if (request.method === "POST" && action === "stop") {
      sendJson(response, 200, await stopServer(server));
      return;
    }
    if (request.method === "POST" && action === "restart") {
      if (isScreenRunning(server)) {
        manualStops.add(server.id);
        await stopServer(server, { keepManualStop: true });
        setTimeout(() => {
          manualStops.delete(server.id);
          startServer(server);
        }, 22000).unref();
      } else {
        startServer(server);
      }
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && action === "command") {
      const body = await readBody(request);
      sendJson(response, 200, await sendCommand(server, body.command));
      return;
    }
    if (request.method === "POST" && action === "backup") {
      sendJson(response, 200, await createBackup(server));
      return;
    }
    if (request.method === "GET" && action === "files") {
      sendJson(response, 200, await getDirectorySummary(server, url.searchParams.get("path") || ""));
      return;
    }
    if (request.method === "GET" && action === "file") {
      sendJson(response, 200, readTextFile(server, url.searchParams.get("path") || ""));
      return;
    }
    if (request.method === "PUT" && action === "file") {
      const body = await readBody(request);
      sendJson(response, 200, writeTextFile(server, url.searchParams.get("path") || "", body.content));
      return;
    }
    if (request.method === "GET" && action === "download") {
      sendDownload(server, url.searchParams.get("path") || "", response);
      return;
    }
    if (request.method === "GET" && action === "logs") {
      sendJson(response, 200, reloadLogBuffer(server));
      return;
    }
    if (request.method === "GET" && action === "players") {
      sendJson(response, 200, { players: publicPlayers(server) });
      return;
    }
    if (request.method === "POST" && action === "player-action") {
      const body = await readBody(request);
      sendJson(response, 200, await playerAction(server, body.action, body.player));
      return;
    }
    if (request.method === "GET" && action === "properties") {
      sendJson(response, 200, readServerProperties(server));
      return;
    }
    if (request.method === "PUT" && action === "properties") {
      const body = await readBody(request);
      sendJson(response, 200, updateServerProperties(server, body.values));
      return;
    }
    if (request.method === "GET" && action === "ram") {
      sendJson(response, 200, readServerRam(server));
      return;
    }
    if (request.method === "PUT" && action === "ram") {
      const body = await readBody(request);
      sendJson(response, 200, updateServerRam(server, body));
      return;
    }
    if (request.method === "PUT" && action === "automation") {
      const body = await readBody(request);
      sendJson(response, 200, { server: publicServer(updateAutomationSettings(server.id, body)) });
      return;
    }
  }

  sendJson(response, 404, { error: "Ruta no encontrada." });
}

const server = createServer((request, response) => {
  if (!request.url.startsWith("/api/")) {
    serveStatic(request, response);
    return;
  }

  handleApi(request, response).catch((error) => {
    sendJson(response, 500, { error: error.message });
  });
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (socket) => {
  clients.add(socket);
  socket.send(JSON.stringify({ type: "hello", payload: { servers: loadConfig().servers.map(publicServer) } }));
  socket.on("close", () => clients.delete(socket));
});

if (IS_IMPORT_WORKER) {
  runImportWorker().catch((error) => {
    writeWorkerMessage({ type: "error", error: error.message });
    process.exitCode = 1;
  });
} else {
  startAllLogWatchers();
  startScreenMonitor();
  startBackupScheduler();

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Minecraft Control Center running at http://127.0.0.1:${PORT}`);
  });
}
