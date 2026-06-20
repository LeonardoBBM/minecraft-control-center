import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cp, readdir, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import { COMMANDS, completeCommand } from "./minecraftCommands.js";

const ROOT = resolve(import.meta.dirname, "..");
const PUBLIC_DIR = join(ROOT, "public");
const DATA_DIR = join(ROOT, "data");
const CONFIG_FILE = join(DATA_DIR, "servers.json");
const BACKUP_DIR = join(DATA_DIR, "backups");
const PORT = Number(process.env.PORT || 4545);

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(BACKUP_DIR, { recursive: true });

const processes = new Map();
const logBuffers = new Map();
const clients = new Set();

function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
}

function saveConfig(config) {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
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
    recentLogs: logs.slice(-80)
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
  broadcast("log", { serverId, ...item });
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
  broadcast("server-state", { serverId: server.id, running: true, pid: child.pid });

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
    appendLog(server.id, `Process exited with code ${code ?? "null"} signal ${signal ?? "none"}`, "system");
    broadcast("server-state", { serverId: server.id, running: false, pid: null });
  });

  child.on("error", (error) => {
    processes.delete(server.id);
    appendLog(server.id, error.message, "error");
    broadcast("server-state", { serverId: server.id, running: false, pid: null });
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
      commands: COMMANDS
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
    const id = body.id || body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (config.servers.some((server) => server.id === id)) {
      sendJson(response, 409, { error: "Ya existe un servidor con ese id." });
      return;
    }
    const server = {
      id,
      name: body.name,
      path: body.path,
      command: body.command || "bash start.sh",
      port: Number(body.port || 25565),
      java: body.java || "system",
      minRam: body.minRam || "",
      maxRam: body.maxRam || "",
      notes: body.notes || ""
    };
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
