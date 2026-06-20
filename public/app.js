const state = {
  servers: [],
  selected: null,
  logs: [],
  commands: [],
  suggestionIndex: -1
};

const $ = (selector) => document.querySelector(selector);

const elements = {
  serverName: $("#serverName"),
  serverPath: $("#serverPath"),
  statusPill: $("#statusPill"),
  metricStatus: $("#metricStatus"),
  metricPort: $("#metricPort"),
  metricRam: $("#metricRam"),
  metricPid: $("#metricPid"),
  miniLog: $("#miniLog"),
  consoleLog: $("#consoleLog"),
  logCount: $("#logCount"),
  commandInput: $("#commandInput"),
  suggestions: $("#suggestions"),
  fileList: $("#fileList")
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Error inesperado");
  }
  return payload;
}

function selectedServer() {
  return state.servers.find((server) => server.id === state.selected) || state.servers[0];
}

function render() {
  const server = selectedServer();
  if (!server) {
    return;
  }

  state.selected = server.id;
  state.logs = server.recentLogs || state.logs;

  elements.serverName.textContent = server.name;
  elements.serverPath.textContent = server.path;
  elements.statusPill.textContent = server.running ? "En linea" : "Detenido";
  elements.statusPill.classList.toggle("online", server.running);
  elements.metricStatus.textContent = server.running ? "Activo" : "Apagado";
  elements.metricPort.textContent = server.port || "--";
  elements.metricRam.textContent = [server.minRam, server.maxRam].filter(Boolean).join(" / ") || "--";
  elements.metricPid.textContent = server.pid || "--";
  $("#settingName").value = server.name || "";
  $("#settingPath").value = server.path || "";
  $("#settingCommand").value = server.command || "";
  $("#settingNotes").value = server.notes || "";
  renderLogs();
}

function renderLogs() {
  const lines = state.logs.slice(-220);
  elements.logCount.textContent = `${state.logs.length} lineas`;
  const html = lines.map((entry) => {
    const time = new Date(entry.at).toLocaleTimeString("es-MX", { hour12: false });
    return `<div class="log-line ${entry.stream}">[${time}] ${escapeHtml(entry.line)}</div>`;
  }).join("");
  elements.miniLog.innerHTML = html || `<div class="log-line system">Sin actividad reciente.</div>`;
  elements.consoleLog.innerHTML = html || `<div class="log-line system">La consola aparecera aqui cuando el servidor emita logs.</div>`;
  elements.miniLog.scrollTop = elements.miniLog.scrollHeight;
  elements.consoleLog.scrollTop = elements.consoleLog.scrollHeight;
}

function renderSuggestions() {
  const value = elements.commandInput.value.trim().split(/\s+/)[0] || "";
  const matches = state.commands
    .filter((entry) => !value || entry.command.startsWith(value.toLowerCase()) || entry.syntax.includes(value.toLowerCase()))
    .slice(0, 8);

  if (!matches.length || document.activeElement !== elements.commandInput) {
    elements.suggestions.classList.remove("open");
    elements.suggestions.innerHTML = "";
    return;
  }

  elements.suggestions.innerHTML = matches.map((entry, index) => `
    <div class="suggestion ${index === state.suggestionIndex ? "active" : ""}" data-command="${entry.command}">
      <code>${escapeHtml(entry.syntax)}</code>
      <span>${escapeHtml(entry.description)}</span>
    </div>
  `).join("");
  elements.suggestions.classList.add("open");
}

function applySuggestion(command) {
  const current = elements.commandInput.value;
  const parts = current.split(/\s+/);
  parts[0] = command;
  elements.commandInput.value = `${parts.join(" ").trim()} `;
  elements.commandInput.focus();
  elements.suggestions.classList.remove("open");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function refresh() {
  const payload = await api("/api/state");
  state.servers = payload.servers;
  state.commands = payload.commands;
  if (!state.selected && state.servers[0]) {
    state.selected = state.servers[0].id;
  }
  render();
}

async function serverAction(action) {
  const server = selectedServer();
  if (!server) {
    return;
  }
  await api(`/api/servers/${server.id}/${action}`, { method: "POST" });
  await refresh();
}

async function loadFiles() {
  const server = selectedServer();
  elements.fileList.innerHTML = `<div class="file-item"><span>Cargando...</span><span></span></div>`;
  const payload = await api(`/api/servers/${server.id}/files`);
  elements.fileList.innerHTML = payload.entries.map((entry) => `
    <div class="file-item">
      <span>${entry.directory ? "[DIR]" : "[FILE]"} ${escapeHtml(entry.name)}</span>
      <span>${entry.directory ? "" : `${Math.round(entry.size / 1024)} KB`}</span>
    </div>
  `).join("");
}

function connectSocket() {
  const socket = new WebSocket(`ws://${location.host}/ws`);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "hello") {
      state.servers = message.payload.servers;
      render();
    }
    if (message.type === "log" && message.payload.serverId === state.selected) {
      state.logs.push(message.payload);
      renderLogs();
    }
    if (message.type === "server-state") {
      const server = state.servers.find((item) => item.id === message.payload.serverId);
      if (server) {
        server.running = message.payload.running;
        server.pid = message.payload.pid;
        render();
      }
    }
  });
  socket.addEventListener("close", () => setTimeout(connectSocket, 1500));
}

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
    button.classList.add("active");
    $(`#${button.dataset.view}`).classList.add("active");
    if (button.dataset.view === "files") {
      loadFiles().catch((error) => {
        elements.fileList.innerHTML = `<div class="file-item"><span>${escapeHtml(error.message)}</span><span></span></div>`;
      });
    }
  });
});

$("#startBtn").addEventListener("click", () => serverAction("start").catch(alert));
$("#stopBtn").addEventListener("click", () => serverAction("stop").catch(alert));
$("#restartBtn").addEventListener("click", () => serverAction("restart").catch(alert));
$("#backupBtn").addEventListener("click", () => serverAction("backup").then((result) => alert(`Backup creado:\n${result.path}`)).catch(alert));
$("#refreshFilesBtn").addEventListener("click", () => loadFiles().catch(alert));
$("#clearConsoleBtn").addEventListener("click", () => {
  state.logs = [];
  renderLogs();
});

$("#commandForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const command = elements.commandInput.value.trim();
  if (!command) {
    return;
  }
  const server = selectedServer();
  await api(`/api/servers/${server.id}/command`, { method: "POST", body: { command } }).catch(alert);
  elements.commandInput.value = "";
  renderSuggestions();
});

elements.commandInput.addEventListener("input", () => {
  state.suggestionIndex = -1;
  renderSuggestions();
});

elements.commandInput.addEventListener("keydown", (event) => {
  const items = [...elements.suggestions.querySelectorAll(".suggestion")];
  if (event.key === "Tab" && items[0]) {
    event.preventDefault();
    applySuggestion(items[Math.max(0, state.suggestionIndex)].dataset.command);
  }
  if (event.key === "ArrowDown" && items.length) {
    event.preventDefault();
    state.suggestionIndex = Math.min(items.length - 1, state.suggestionIndex + 1);
    renderSuggestions();
  }
  if (event.key === "ArrowUp" && items.length) {
    event.preventDefault();
    state.suggestionIndex = Math.max(0, state.suggestionIndex - 1);
    renderSuggestions();
  }
  if (event.key === "Enter" && state.suggestionIndex >= 0 && items[state.suggestionIndex]) {
    event.preventDefault();
    applySuggestion(items[state.suggestionIndex].dataset.command);
  }
});

elements.suggestions.addEventListener("mousedown", (event) => {
  const item = event.target.closest(".suggestion");
  if (item) {
    applySuggestion(item.dataset.command);
  }
});

refresh().catch((error) => alert(error.message));
connectSocket();
