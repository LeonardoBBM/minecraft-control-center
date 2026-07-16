const state = {
  servers: [],
  selected: null,
  logs: [],
  commands: [],
  properties: null,
  ram: null,
  players: [],
  memory: null,
  suggestionIndex: -1
};

const $ = (selector) => document.querySelector(selector);

const elements = {
  serverName: $("#serverName"),
  serverPath: $("#serverPath"),
  statusPill: $("#statusPill"),
  serverSelect: $("#serverSelect"),
  newInstanceBtn: $("#newInstanceBtn"),
  newInstanceDialog: $("#newInstanceDialog"),
  newInstanceForm: $("#newInstanceForm"),
  newInstanceStatus: $("#newInstanceStatus"),
  metricStatus: $("#metricStatus"),
  metricPort: $("#metricPort"),
  metricRam: $("#metricRam"),
  metricPid: $("#metricPid"),
  miniLog: $("#miniLog"),
  consoleLog: $("#consoleLog"),
  consoleLogSource: $("#consoleLogSource"),
  logCount: $("#logCount"),
  commandInput: $("#commandInput"),
  suggestions: $("#suggestions"),
  fileList: $("#fileList"),
  playerList: $("#playerList"),
  playerCount: $("#playerCount"),
  propertiesForm: $("#propertiesForm"),
  propertiesStatus: $("#propertiesStatus"),
  ramForm: $("#ramForm"),
  ramStatus: $("#ramStatus"),
  ramSystem: $("#ramSystem"),
  ramCurrent: $("#ramCurrent"),
  ramRecommended: $("#ramRecommended"),
  minRamInput: $("#minRamInput"),
  maxRamInput: $("#maxRamInput"),
  settingBackupSchedule: $("#settingBackupSchedule"),
  settingAutoRestart: $("#settingAutoRestart"),
  automationStatus: $("#automationStatus")
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

function activeView() {
  return document.querySelector(".view.active")?.id || "dashboard";
}

function clearServerScopedState() {
  state.logs = [];
  state.properties = null;
  state.ram = null;
  state.players = [];
}

function renderServerSelect() {
  elements.serverSelect.innerHTML = state.servers.map((server) => `
    <option value="${escapeHtml(server.id)}" ${server.id === state.selected ? "selected" : ""}>
      ${escapeHtml(server.name)}
    </option>
  `).join("");
  elements.serverSelect.disabled = state.servers.length < 2;
}

function render() {
  const server = selectedServer();
  if (!server) {
    elements.serverName.textContent = "Sin instancias";
    elements.serverPath.textContent = "Agrega una instancia para empezar.";
    renderServerSelect();
    return;
  }

  state.selected = server.id;
  state.logs = server.recentLogs || state.logs;
  state.players = server.players || state.players;
  renderServerSelect();

  elements.serverName.textContent = server.name;
  elements.serverPath.textContent = server.path;
  elements.statusPill.textContent = server.running ? "En linea" : "Detenido";
  elements.statusPill.classList.toggle("online", server.running);
  elements.metricStatus.textContent = server.running ? "Activo" : "Apagado";
  elements.metricPort.textContent = server.port || "--";
  elements.metricRam.textContent = [server.minRam, server.maxRam].filter(Boolean).join(" / ") || "--";
  elements.metricPid.textContent = server.pid || "--";
  elements.consoleLogSource.textContent = server.logFile || "logs/latest.log";
  $("#settingName").value = server.name || "";
  $("#settingPath").value = server.path || "";
  $("#settingCommand").value = server.command || "";
  $("#settingNotes").value = server.notes || "";
  elements.settingBackupSchedule.value = server.backupSchedule || "";
  elements.settingAutoRestart.checked = Boolean(server.autoRestart);
  elements.automationStatus.textContent = "Automatizacion sin cambios";
  renderLogs();
  renderPlayers();
}

function upsertServer(updatedServer) {
  const index = state.servers.findIndex((server) => server.id === updatedServer.id);
  if (index === -1) {
    state.servers.push(updatedServer);
  } else {
    state.servers[index] = updatedServer;
  }
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

function playerAvatarUrl(name) {
  return `https://mc-heads.net/avatar/${encodeURIComponent(name)}/48`;
}

function renderPlayers() {
  const players = state.players || [];
  elements.playerCount.textContent = `${players.length} conectados`;

  if (!players.length) {
    elements.playerList.innerHTML = `
      <div class="player-empty">
        No hay jugadores detectados. Inicia el servidor desde este panel y usa Actualizar.
      </div>
    `;
    return;
  }

  elements.playerList.innerHTML = players.map((player) => {
    const name = escapeHtml(player.name);
    const opBadge = player.op ? `<span class="player-badge">OP</span>` : "";
    const opButton = player.op
      ? `<button data-player-action="deop" data-player="${name}">Quitar OP</button>`
      : `<button data-player-action="op" data-player="${name}">Hacer OP</button>`;

    return `
      <article class="player-card">
        <img src="${playerAvatarUrl(player.name)}" alt="" loading="lazy" />
        <div class="player-info">
          <strong>${name}</strong>
          <span>En linea ${opBadge}</span>
        </div>
        <div class="player-actions">
          <button data-player-action="kick" data-player="${name}">Expulsar</button>
          <button class="danger" data-player-action="ban" data-player="${name}">Banear</button>
          <button data-player-action="kill" data-player="${name}">Matar</button>
          ${opButton}
          <button data-player-action="whitelist" data-player="${name}">Whitelist</button>
        </div>
      </article>
    `;
  }).join("");
}

function commandMatches() {
  const value = elements.commandInput.value.trim().split(/\s+/)[0] || "";
  const query = value.toLowerCase();
  if (!query) {
    return state.commands.slice(0, 8);
  }

  const prefixMatches = state.commands.filter((entry) => entry.command.startsWith(query));
  if (prefixMatches.length) {
    return prefixMatches.slice(0, 8);
  }

  return state.commands
    .filter((entry) => entry.command.includes(query) || entry.syntax.toLowerCase().includes(query))
    .slice(0, 8);
}

function renderSuggestions() {
  const matches = commandMatches();

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

function completeSuggestion(direction = 1) {
  const matches = commandMatches();
  if (!matches.length) {
    return false;
  }

  let index = state.suggestionIndex;
  if (index < 0) {
    index = direction < 0 ? matches.length - 1 : 0;
  }

  applySuggestion(matches[index].command);
  state.suggestionIndex = -1;
  return true;
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
  state.memory = payload.memory;
  if ((!state.selected || !state.servers.some((server) => server.id === state.selected)) && state.servers[0]) {
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

async function loadPlayers() {
  const server = selectedServer();
  if (!server) {
    return;
  }
  const payload = await api(`/api/servers/${server.id}/players`);
  state.players = payload.players;
  renderPlayers();
}

async function loadPersistentLogs() {
  const server = selectedServer();
  if (!server) {
    return;
  }
  const payload = await api(`/api/servers/${server.id}/logs`);
  state.logs = payload.entries || [];
  elements.consoleLogSource.textContent = payload.file || server.logFile || "logs/latest.log";
  renderLogs();
}

async function runPlayerAction(action, player = "") {
  const server = selectedServer();
  if (!server) {
    return;
  }
  const payload = await api(`/api/servers/${server.id}/player-action`, {
    method: "POST",
    body: { action, player }
  });
  state.players = payload.players;
  renderPlayers();
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

function renderProperties() {
  const data = state.properties;
  if (!data) {
    elements.propertiesForm.innerHTML = `<div class="property-empty">Carga las propiedades del servidor.</div>`;
    return;
  }

  elements.propertiesStatus.textContent = data.file;
  elements.propertiesForm.innerHTML = data.fields.map((field) => {
    const value = field.value ?? "";
    const description = field.description ? `<small>${escapeHtml(field.description)}</small>` : "";

    if (field.type === "select") {
      const options = field.options.map((option) => `
        <option value="${escapeHtml(option)}" ${option === value ? "selected" : ""}>${escapeHtml(option)}</option>
      `).join("");
      return `
        <label class="property-field">
          <span>${escapeHtml(field.label)}</span>
          <select data-property-key="${escapeHtml(field.key)}">${options}</select>
          ${description}
        </label>
      `;
    }

    if (field.type === "boolean") {
      return `
        <label class="property-toggle">
          <input data-property-key="${escapeHtml(field.key)}" type="checkbox" ${value === "true" ? "checked" : ""} />
          <span>${escapeHtml(field.label)}</span>
          ${description}
        </label>
      `;
    }

    const numberAttrs = field.type === "number"
      ? `type="number" min="${field.min ?? ""}" max="${field.max ?? ""}"`
      : `type="text"`;
    return `
      <label class="property-field">
        <span>${escapeHtml(field.label)}</span>
        <input data-property-key="${escapeHtml(field.key)}" ${numberAttrs} value="${escapeHtml(value)}" />
        ${description}
      </label>
    `;
  }).join("");
}

async function loadProperties() {
  const server = selectedServer();
  if (!server) {
    return;
  }

  elements.propertiesStatus.textContent = "Cargando...";
  state.properties = await api(`/api/servers/${server.id}/properties`);
  renderProperties();
}

async function saveProperties() {
  const server = selectedServer();
  if (!server) {
    return;
  }

  const values = {};
  for (const input of elements.propertiesForm.querySelectorAll("[data-property-key]")) {
    values[input.dataset.propertyKey] = input.type === "checkbox" ? String(input.checked) : input.value;
  }

  elements.propertiesStatus.textContent = "Guardando...";
  state.properties = await api(`/api/servers/${server.id}/properties`, { method: "PUT", body: { values } });
  renderProperties();
  elements.propertiesStatus.textContent = "Guardado. Reinicia el servidor para aplicar la mayoria de cambios.";
}

function ramValueToNumber(value) {
  const match = String(value || "").match(/^(\d+)/);
  return match ? Number(match[1]) : "";
}

function renderRam() {
  const data = state.ram;
  const memory = data?.memory || state.memory;
  if (!data) {
    elements.ramStatus.textContent = "Carga la configuracion de RAM.";
    elements.ramSystem.textContent = memory
      ? `${memory.totalGb} GiB total / ${memory.availableGb} GiB libre ahora`
      : "--";
    return;
  }

  elements.ramStatus.textContent = data.file;
  elements.ramSystem.textContent = `${memory.totalGb} GiB total / ${memory.availableGb} GiB libre ahora`;
  elements.ramCurrent.textContent = `${data.minRam || "--"} / ${data.maxRam || "--"}`;
  elements.ramRecommended.textContent = `${memory.recommendedMinGb}G / ${memory.recommendedMaxGb}G`;
  elements.minRamInput.value = ramValueToNumber(data.minRam || `${memory.recommendedMinGb}G`);
  elements.maxRamInput.value = ramValueToNumber(data.maxRam || `${memory.recommendedMaxGb}G`);
  elements.minRamInput.max = memory.maxAllowedGb;
  elements.maxRamInput.max = memory.maxAllowedGb;
  $("#ramLimit").textContent = `${memory.maxAllowedGb}G`;
}

async function loadRam() {
  const server = selectedServer();
  if (!server) {
    return;
  }

  elements.ramStatus.textContent = "Cargando...";
  state.ram = await api(`/api/servers/${server.id}/ram`);
  renderRam();
}

async function saveRam() {
  const server = selectedServer();
  if (!server) {
    return;
  }

  elements.ramStatus.textContent = "Guardando...";
  state.ram = await api(`/api/servers/${server.id}/ram`, {
    method: "PUT",
    body: {
      minGb: Number(elements.minRamInput.value),
      maxGb: Number(elements.maxRamInput.value)
    }
  });
  if (state.ram.server) {
    upsertServer(state.ram.server);
  }
  render();
  renderRam();
  elements.ramStatus.textContent = "Guardado. Reinicia el servidor para usar la nueva RAM.";
}

async function saveAutomation() {
  const server = selectedServer();
  if (!server) {
    return;
  }

  elements.automationStatus.textContent = "Guardando...";
  const payload = await api(`/api/servers/${server.id}/automation`, {
    method: "PUT",
    body: {
      backupSchedule: elements.settingBackupSchedule.value,
      autoRestart: elements.settingAutoRestart.checked
    }
  });
  if (payload.server) {
    upsertServer(payload.server);
  }
  render();
  elements.automationStatus.textContent = "Automatizacion guardada.";
}

function openNewInstanceDialog() {
  elements.newInstanceStatus.textContent = "Registra una carpeta de server pack existente.";
  elements.newInstanceForm.reset();
  elements.newInstanceForm.elements.command.value = "bash start.sh";
  elements.newInstanceForm.elements.port.value = nextAvailablePort();
  if (typeof elements.newInstanceDialog.showModal === "function") {
    elements.newInstanceDialog.showModal();
  } else {
    elements.newInstanceDialog.setAttribute("open", "");
  }
}

function closeNewInstanceDialog() {
  elements.newInstanceDialog.close();
}

function nextAvailablePort() {
  const used = new Set(state.servers.map((server) => Number(server.port)));
  let port = 25566;
  while (used.has(port)) {
    port += 1;
  }
  return port;
}

async function createInstance() {
  const formData = new FormData(elements.newInstanceForm);
  const body = Object.fromEntries(formData.entries());
  elements.newInstanceStatus.textContent = "Guardando...";
  const server = await api("/api/servers", { method: "POST", body });
  upsertServer(server);
  state.selected = server.id;
  clearServerScopedState();
  render();
  closeNewInstanceDialog();
  await refresh();
}

async function reloadActiveView() {
  const view = activeView();
  if (view === "files") {
    await loadFiles();
  }
  if (view === "console") {
    await loadPersistentLogs();
  }
  if (view === "properties") {
    await loadProperties();
  }
  if (view === "performance") {
    await loadRam();
  }
}

function connectSocket() {
  const socket = new WebSocket(`ws://${location.host}/ws`);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "hello") {
      state.servers = message.payload.servers;
      if ((!state.selected || !state.servers.some((server) => server.id === state.selected)) && state.servers[0]) {
        state.selected = state.servers[0].id;
      }
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
    if (message.type === "players" && message.payload.serverId === state.selected) {
      state.players = message.payload.players;
      renderPlayers();
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
    if (button.dataset.view === "properties") {
      loadProperties().catch((error) => {
        elements.propertiesStatus.textContent = error.message;
        elements.propertiesForm.innerHTML = "";
      });
    }
    if (button.dataset.view === "performance") {
      loadRam().catch((error) => {
        elements.ramStatus.textContent = error.message;
      });
    }
    if (button.dataset.view === "console") {
      loadPersistentLogs().catch(alert);
    }
  });
});

$("#startBtn").addEventListener("click", () => serverAction("start").catch(alert));
$("#stopBtn").addEventListener("click", () => serverAction("stop").catch(alert));
$("#restartBtn").addEventListener("click", () => serverAction("restart").catch(alert));
$("#backupBtn").addEventListener("click", () => serverAction("backup").then((result) => alert(`Backup creado:\n${result.path}`)).catch(alert));
elements.serverSelect.addEventListener("change", () => {
  state.selected = elements.serverSelect.value;
  clearServerScopedState();
  render();
  reloadActiveView().catch(alert);
});
elements.newInstanceBtn.addEventListener("click", openNewInstanceDialog);
$("#closeNewInstanceBtn").addEventListener("click", closeNewInstanceDialog);
$("#cancelNewInstanceBtn").addEventListener("click", closeNewInstanceDialog);
elements.newInstanceForm.addEventListener("submit", (event) => {
  event.preventDefault();
  createInstance().catch((error) => {
    elements.newInstanceStatus.textContent = error.message;
  });
});
$("#refreshPlayersBtn").addEventListener("click", () => runPlayerAction("refresh").catch(alert));
$("#refreshFilesBtn").addEventListener("click", () => loadFiles().catch(alert));
$("#reloadPropertiesBtn").addEventListener("click", () => loadProperties().catch(alert));
$("#reloadRamBtn").addEventListener("click", () => loadRam().catch(alert));
$("#reloadLogsBtn").addEventListener("click", () => loadPersistentLogs().catch(alert));
$("#saveAutomationBtn").addEventListener("click", () => saveAutomation().catch((error) => {
  elements.automationStatus.textContent = error.message;
}));
$("#recommendedRamBtn").addEventListener("click", () => {
  const memory = state.ram?.memory || state.memory;
  if (!memory) {
    return;
  }
  elements.minRamInput.value = memory.recommendedMinGb;
  elements.maxRamInput.value = memory.recommendedMaxGb;
});
$("#propertiesForm").addEventListener("submit", (event) => {
  event.preventDefault();
  saveProperties().catch(alert);
});
$("#ramForm").addEventListener("submit", (event) => {
  event.preventDefault();
  saveRam().catch(alert);
});
$("#clearConsoleBtn").addEventListener("click", () => {
  state.logs = [];
  renderLogs();
});

elements.playerList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-player-action]");
  if (!button) {
    return;
  }

  const action = button.dataset.playerAction;
  const player = button.dataset.player;
  if ((action === "ban" || action === "kick") && !confirm(`Confirmar ${button.textContent.toLowerCase()} a ${player}`)) {
    return;
  }
  runPlayerAction(action, player).catch(alert);
});

$("#commandForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const command = elements.commandInput.value.trim();
  if (!command) {
    return;
  }
  const server = selectedServer();
  try {
    await api(`/api/servers/${server.id}/command`, { method: "POST", body: { command } });
    elements.commandInput.value = "";
    renderSuggestions();
  } catch (error) {
    alert(error.message);
  }
});

elements.commandInput.addEventListener("input", () => {
  state.suggestionIndex = -1;
  renderSuggestions();
});

elements.commandInput.addEventListener("keydown", (event) => {
  const items = [...elements.suggestions.querySelectorAll(".suggestion")];
  if (event.key === "Tab") {
    if (completeSuggestion(event.shiftKey ? -1 : 1)) {
      event.preventDefault();
    }
    return;
  }
  if (event.key === "Enter" && state.suggestionIndex >= 0 && items[state.suggestionIndex]) {
    event.preventDefault();
    applySuggestion(items[state.suggestionIndex].dataset.command);
    return;
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
});

elements.suggestions.addEventListener("mousedown", (event) => {
  const item = event.target.closest(".suggestion");
  if (item) {
    applySuggestion(item.dataset.command);
  }
});

refresh().catch((error) => alert(error.message));
connectSocket();
