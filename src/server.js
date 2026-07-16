import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cp, readdir, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { freemem, totalmem } from "node:os";
import { WebSocketServer } from "ws";
import { COMMANDS, completeCommand } from "./minecraftCommands.js";

const ROOT = resolve(import.meta.dirname, "..");
const PUBLIC_DIR = join(ROOT, "public");
const DATA_DIR = join(ROOT, "data");
const CONFIG_FILE = join(DATA_DIR, "servers.json");
const BACKUP_DIR = join(DATA_DIR, "backups");
const PORT = Number(process.env.PORT || 4545);
const RESTART_WINDOW_MS = 5 * 60 * 1000;
const RESTART_DELAY_MS = 10 * 1000;
const MAX_RESTARTS_IN_WINDOW = 3;
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

function updateAutomationSettings(serverId, values) {
  const updates = {
    autoRestart: normalizeBoolean(values?.autoRestart),
    backupSchedule: validateCronSchedule(values?.backupSchedule)
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
    notes: String(body?.notes || "").trim()
  };
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

function findServer(id) {
  return loadConfig().servers.find((server) => server.id === id);
}

function publicServer(server) {
  const info = screenInfo(server);
  const running = Boolean(info);
  const logs = logBuffers.get(server.id) || [];
  return {
    ...server,
    running,
    pid: running ? info.pid : null,
    supervisor: "screen",
    session: screenSessionName(server),
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
          scheduleAutoRestart(server);
        }
        broadcastPlayers(server.id);
      }
      broadcast("server-state", { serverId: server.id, running, pid: info?.pid || null });
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
    return;
  }

  scheduledRestarts.add(server.id);
  appendLog(server.id, "Auto-restart scheduled in 10 seconds.", "system");
  setTimeout(() => {
    scheduledRestarts.delete(server.id);
    const current = findServer(server.id);
    if (current && !isScreenRunning(current)) {
      try {
        startServer(current);
      } catch (error) {
        appendLog(server.id, `Auto-restart failed: ${error.message}`, "error");
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
      .catch((error) => appendLog(server.id, `Scheduled backup failed: ${error.message}`, "error"))
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

function playerAction(server, action, playerName) {
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

  sendCommand(server, command);
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
  broadcast("server-state", { serverId: server.id, running: true, pid: info?.pid || null });
  broadcastPlayers(server.id);
  return { ok: true, pid: info?.pid || null, session };
}

function sendCommand(server, command) {
  if (!isScreenRunning(server)) {
    throw new Error("El servidor no esta corriendo en screen.");
  }
  runScreen(["-S", screenSessionName(server), "-X", "stuff", `${command}\n`]);
  appendLog(server.id, `> ${command}`, "command");
  return { ok: true };
}

function stopServer(server) {
  if (!isScreenRunning(server)) {
    return { ok: true, alreadyStopped: true };
  }

  manualStops.add(server.id);
  runScreen(["-S", screenSessionName(server), "-X", "stuff", "stop\n"]);
  appendLog(server.id, "> stop", "command");
  setTimeout(() => {
    if (isScreenRunning(server)) {
      runScreen(["-S", screenSessionName(server), "-X", "quit"]);
      appendLog(server.id, "screen session closed after graceful stop timeout.", "system");
    }
    manualStops.delete(server.id);
    broadcast("server-state", { serverId: server.id, running: false, pid: null });
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

async function getDirectorySummary(path) {
  const resolved = resolve(path);
  const entries = await readdir(resolved);
  const summary = [];
  for (const entry of entries.slice(0, 200)) {
    const fullPath = join(resolved, entry);
    const itemStat = await stat(fullPath);
    summary.push({ name: entry, directory: itemStat.isDirectory(), size: itemStat.size });
  }
  return summary;
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

  if (segments[0] === "api" && segments[1] === "servers" && segments[2]) {
    const server = findServer(segments[2]);
    if (!server) {
      sendJson(response, 404, { error: "Servidor no encontrado." });
      return;
    }

    const action = segments[3];
    if (request.method === "POST" && action === "start") {
      sendJson(response, 200, startServer(server));
      return;
    }
    if (request.method === "POST" && action === "stop") {
      sendJson(response, 200, stopServer(server));
      return;
    }
    if (request.method === "POST" && action === "restart") {
      if (isScreenRunning(server)) {
        stopServer(server);
        setTimeout(() => startServer(server), 22000).unref();
      } else {
        startServer(server);
      }
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && action === "command") {
      const body = await readBody(request);
      sendJson(response, 200, sendCommand(server, body.command));
      return;
    }
    if (request.method === "POST" && action === "backup") {
      sendJson(response, 200, await createBackup(server));
      return;
    }
    if (request.method === "GET" && action === "files") {
      sendJson(response, 200, { path: server.path, entries: await getDirectorySummary(server.path) });
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
      sendJson(response, 200, playerAction(server, body.action, body.player));
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

startAllLogWatchers();
startScreenMonitor();
startBackupScheduler();

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Minecraft Control Center running at http://127.0.0.1:${PORT}`);
});
