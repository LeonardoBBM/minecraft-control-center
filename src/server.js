import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cp, readdir, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { spawn } from "node:child_process";
import { freemem, totalmem } from "node:os";
import { WebSocketServer } from "ws";
import { COMMANDS, completeCommand } from "./minecraftCommands.js";

const ROOT = resolve(import.meta.dirname, "..");
const PUBLIC_DIR = join(ROOT, "public");
const DATA_DIR = join(ROOT, "data");
const CONFIG_FILE = join(DATA_DIR, "servers.json");
const BACKUP_DIR = join(DATA_DIR, "backups");
const PORT = Number(process.env.PORT || 4545);
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

const processes = new Map();
const logBuffers = new Map();
const clients = new Set();
const playerState = new Map();

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
    notes: String(body?.notes || "").trim()
  };
}

function findServer(id) {
  return loadConfig().servers.find((server) => server.id === id);
}

function publicServer(server) {
  const running = processes.has(server.id);
  const logs = logBuffers.get(server.id) || [];
  return {
    ...server,
    running,
    pid: running ? processes.get(server.id).pid : null,
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
  if (processes.has(server.id)) {
    return { ok: true, alreadyRunning: true };
  }

  if (!existsSync(server.path)) {
    throw new Error(`La carpeta no existe: ${server.path}`);
  }

  const [command, ...args] = parseCommandLine(server.command);
  if (!command) {
    throw new Error("El comando de arranque esta vacio.");
  }

  appendLog(server.id, `Starting: ${server.command}`, "system");
  const child = spawn(command, args, {
    cwd: server.path,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });

  processes.set(server.id, child);
  playerState.set(server.id, new Map());
  broadcast("server-state", { serverId: server.id, running: true, pid: child.pid });
  broadcastPlayers(server.id);

  child.stdout.on("data", (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
      appendLog(server.id, line, "stdout");
    }
  });

  child.stderr.on("data", (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
      appendLog(server.id, line, "stderr");
    }
  });

  child.on("exit", (code, signal) => {
    processes.delete(server.id);
    playerState.set(server.id, new Map());
    appendLog(server.id, `Process exited with code ${code ?? "null"} signal ${signal ?? "none"}`, "system");
    broadcast("server-state", { serverId: server.id, running: false, pid: null });
    broadcastPlayers(server.id);
  });

  child.on("error", (error) => {
    processes.delete(server.id);
    playerState.set(server.id, new Map());
    appendLog(server.id, error.message, "error");
    broadcast("server-state", { serverId: server.id, running: false, pid: null });
    broadcastPlayers(server.id);
  });

  return { ok: true, pid: child.pid };
}

function sendCommand(server, command) {
  const child = processes.get(server.id);
  if (!child || !child.stdin.writable) {
    throw new Error("El servidor no esta corriendo desde este panel.");
  }
  child.stdin.write(`${command}\n`);
  appendLog(server.id, `> ${command}`, "command");
  return { ok: true };
}

function stopServer(server) {
  const child = processes.get(server.id);
  if (!child) {
    return { ok: true, alreadyStopped: true };
  }
  child.stdin.write("stop\n");
  appendLog(server.id, "> stop", "command");
  setTimeout(() => {
    if (processes.get(server.id) === child) {
      child.kill("SIGTERM");
      appendLog(server.id, "SIGTERM sent after graceful stop timeout.", "system");
    }
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
      stopServer(server);
      setTimeout(() => startServer(server), 3500).unref();
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

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Minecraft Control Center running at http://127.0.0.1:${PORT}`);
});
