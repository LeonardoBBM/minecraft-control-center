const state = {
    servers: [],
    selected: null,
    logs: [],
    logServerId: null,
    commands: [],
    properties: null,
    ram: null,
    players: [],
    playersServerId: null,
    memory: null,
    filePath: "",
    currentFile: null,
    suggestionIndex: -1,
    automationDirty: false,
    importJobId: null,
    importPollTimer: null
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
    importSourcePath: $("#importSourcePath"),
    browseImportSourceBtn: $("#browseImportSourceBtn"),
    importBrowserPanel: $("#importBrowserPanel"),
    importBrowserPath: $("#importBrowserPath"),
    importBrowserUpBtn: $("#importBrowserUpBtn"),
    useCurrentImportFolderBtn: $("#useCurrentImportFolderBtn"),
    importBrowserList: $("#importBrowserList"),
    importInstanceBtn: $("#importInstanceBtn"),
    cancelImportBtn: $("#cancelImportBtn"),
    importProgress: $("#importProgress"),
    importProgressTitle: $("#importProgressTitle"),
    importProgressDetail: $("#importProgressDetail"),
    importProgressBar: $("#importProgressBar"),
    metricStatus: $("#metricStatus"),
    metricPort: $("#metricPort"),
    metricRam: $("#metricRam"),
    metricPid: $("#metricPid"),
    metricCpu: $("#metricCpu"),
    metricMemory: $("#metricMemory"),
    miniLog: $("#miniLog"),
    consoleLog: $("#consoleLog"),
    consoleLogSource: $("#consoleLogSource"),
    logCount: $("#logCount"),
    commandInput: $("#commandInput"),
    suggestions: $("#suggestions"),
    fileList: $("#fileList"),
    filePathLabel: $("#filePathLabel"),
    upFilesBtn: $("#upFilesBtn"),
    fileEditorPanel: $("#fileEditorPanel"),
    fileEditorTitle: $("#fileEditorTitle"),
    fileEditorStatus: $("#fileEditorStatus"),
    fileEditorContent: $("#fileEditorContent"),
    downloadFileBtn: $("#downloadFileBtn"),
    saveFileBtn: $("#saveFileBtn"),
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
    settingNotifyWebhookUrl: $("#settingNotifyWebhookUrl"),
    settingAutoRestart: $("#settingAutoRestart"),
    automationStatus: $("#automationStatus"),
    startBtn: $("#startBtn"),
    restartBtn: $("#restartBtn"),
    stopBtn: $("#stopBtn"),
    backupBtn: $("#backupBtn"),
    socketStatus: $("#socketStatus"),
    socketDot: $("#socketDot"),
    toastRegion: $("#toastRegion")
};

function notify(message, type = "success", duration = 4200) {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;

    const text = document.createElement("span");
    text.textContent = String(message);

    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Cerrar notificación");
    close.textContent = "×";

    const dismiss = () => {
        toast.remove();
    };

    close.addEventListener("click", dismiss);
    toast.append(text, close);
    elements.toastRegion.append(toast);
    setTimeout(dismiss, duration);
}

function reportError(error) {
    notify(error?.message || String(error), "error", 6500);
}

function setSocketStatus(status) {
    const labels = {
        connecting: "Conectando…",
        connected: "Actualización en vivo",
        disconnected: "Reconectando…"
    };

    elements.socketStatus.textContent = labels[status] || labels.connecting;
    elements.socketDot.classList.toggle("connected", status === "connected");
    elements.socketDot.classList.toggle(
        "disconnected",
        status === "disconnected"
    );
}

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
    return (
        state.servers.find((server) => server.id === state.selected) ||
        state.servers[0]
    );
}

function activeView() {
    return document.querySelector(".view.active")?.id || "dashboard";
}

function clearServerScopedState() {
    state.logs = [];
    state.logServerId = null;
    state.properties = null;
    state.ram = null;
    state.players = [];
    state.playersServerId = null;
    state.filePath = "";
    state.currentFile = null;
    state.automationDirty = false;
}

function renderServerSelect() {
    elements.serverSelect.innerHTML = state.servers
        .map(
            (server) => `
        <option
          value="${escapeHtml(server.id)}"
          ${server.id === state.selected ? "selected" : ""}
        >
          ${escapeHtml(server.name)}
        </option>
      `
        )
        .join("");

    elements.serverSelect.disabled = state.servers.length < 2;
}

function render() {
    const server = selectedServer();

    if (!server) {
        elements.serverName.textContent = "Sin instancias";
        elements.serverPath.textContent = "Agrega una instancia para empezar.";
        elements.statusPill.textContent = "Sin instancia";
        elements.statusPill.classList.remove("online");
        elements.statusPill.classList.add("offline");
        elements.startBtn.disabled = true;
        elements.restartBtn.disabled = true;
        elements.stopBtn.disabled = true;
        elements.backupBtn.disabled = true;
        renderServerSelect();
        return;
    }

    state.selected = server.id;

    if (state.logServerId !== server.id) {
        state.logs = server.recentLogs || [];
        state.logServerId = server.id;
    }

    if (state.playersServerId !== server.id) {
        state.players = server.players || [];
        state.playersServerId = server.id;
    }

    renderServerSelect();

    elements.serverName.textContent = server.name;
    elements.serverPath.textContent = server.path;
    elements.statusPill.textContent = server.running
        ? "En línea"
        : "Detenido";

    elements.statusPill.classList.toggle("online", server.running);
    elements.statusPill.classList.toggle("offline", !server.running);

    elements.metricStatus.textContent = server.running
        ? "Activo"
        : "Apagado";

    elements.metricPort.textContent = server.port || "--";

    elements.metricRam.textContent =
        [server.minRam, server.maxRam].filter(Boolean).join(" / ") || "--";

    elements.metricPid.textContent = server.pid || "--";

    elements.metricCpu.textContent = server.usage
        ? `${server.usage.cpuPercent}%`
        : "--";

    elements.metricMemory.textContent = server.usage
        ? `${server.usage.rssMb} MB`
        : "--";

    elements.consoleLogSource.textContent =
        server.logFile || "logs/latest.log";

    $("#settingName").value = server.name || "";
    $("#settingPath").value = server.path || "";
    $("#settingCommand").value = server.command || "";
    $("#settingNotes").value = server.notes || "";

    elements.startBtn.disabled = server.running;
    elements.restartBtn.disabled = false;
    elements.stopBtn.disabled = !server.running;
    elements.backupBtn.disabled = false;

    if (!state.automationDirty) {
        elements.settingBackupSchedule.value =
            server.backupSchedule || "";

        elements.settingNotifyWebhookUrl.value =
            server.notifyWebhookUrl || "";

        elements.settingAutoRestart.checked =
            Boolean(server.autoRestart);

        elements.automationStatus.textContent = "Sin cambios";
    }

    renderLogs();
    renderPlayers();
}

function upsertServer(updatedServer) {
    const index = state.servers.findIndex(
        (server) => server.id === updatedServer.id
    );

    if (index === -1) {
        state.servers.push(updatedServer);
    } else {
        state.servers[index] = updatedServer;
    }
}

function renderLogs() {
    const lines = state.logs.slice(-220);

    elements.logCount.textContent = `${state.logs.length} líneas`;

    const html = lines
        .map((entry) => {
            const time = new Date(entry.at).toLocaleTimeString("es-MX", {
                hour12: false
            });

            return `
        <div class="log-line ${entry.stream}">
          [${time}] ${escapeHtml(entry.line)}
        </div>
      `;
        })
        .join("");

    elements.miniLog.innerHTML =
        html ||
        `<div class="log-line system">Sin actividad reciente.</div>`;

    elements.consoleLog.innerHTML =
        html ||
        `<div class="log-line system">
      La consola aparecerá aquí cuando el servidor emita logs.
    </div>`;

    elements.miniLog.scrollTop = elements.miniLog.scrollHeight;
    elements.consoleLog.scrollTop = elements.consoleLog.scrollHeight;
}

function playerAvatarUrl(name) {
    return `https://mc-heads.net/avatar/${encodeURIComponent(name)}/48`;
}

function renderPlayers() {
    const players = state.players || [];

    elements.playerCount.textContent =
        `${players.length} conectados`;

    if (!players.length) {
        elements.playerList.innerHTML = `
      <div class="player-empty">
        No hay jugadores detectados. Inicia el servidor desde
        este panel y usa Actualizar.
      </div>
    `;
        return;
    }

    elements.playerList.innerHTML = players
        .map((player) => {
            const name = escapeHtml(player.name);

            const opBadge = player.op
                ? `<span class="player-badge">OP</span>`
                : "";

            const opButton = player.op
                ? `
          <button data-player-action="deop" data-player="${name}">
            Quitar OP
          </button>
        `
                : `
          <button data-player-action="op" data-player="${name}">
            Hacer OP
          </button>
        `;

            return `
        <article class="player-card">
          <img
            src="${playerAvatarUrl(player.name)}"
            alt=""
            loading="lazy"
          >

          <div class="player-info">
            <strong>${name}</strong>
            <span>En línea ${opBadge}</span>
          </div>

          <div class="player-actions">
            <button
              data-player-action="kick"
              data-player="${name}"
            >
              Expulsar
            </button>

            <button
              class="danger"
              data-player-action="ban"
              data-player="${name}"
            >
              Banear
            </button>

            <button
              data-player-action="kill"
              data-player="${name}"
            >
              Matar
            </button>

            ${opButton}

            <button
              data-player-action="whitelist"
              data-player="${name}"
            >
              Whitelist
            </button>
          </div>
        </article>
      `;
        })
        .join("");
}

function commandMatches() {
    const value =
        elements.commandInput.value.trim().split(/\s+/)[0] || "";

    const query = value.toLowerCase();

    if (!query) {
        return state.commands.slice(0, 8);
    }

    const prefixMatches = state.commands.filter((entry) =>
        entry.command.startsWith(query)
    );

    if (prefixMatches.length) {
        return prefixMatches.slice(0, 8);
    }

    return state.commands
        .filter(
            (entry) =>
                entry.command.includes(query) ||
                entry.syntax.toLowerCase().includes(query)
        )
        .slice(0, 8);
}

function renderSuggestions() {
    const matches = commandMatches();

    if (
        !matches.length ||
        document.activeElement !== elements.commandInput
    ) {
        elements.suggestions.classList.remove("open");
        elements.suggestions.innerHTML = "";
        return;
    }

    elements.suggestions.innerHTML = matches
        .map(
            (entry, index) => `
        <div
          class="suggestion ${index === state.suggestionIndex ? "active" : ""
                }"
          data-command="${entry.command}"
        >
          <code>${escapeHtml(entry.syntax)}</code>
          <span>${escapeHtml(entry.description)}</span>
        </div>
      `
        )
        .join("");

    elements.suggestions.classList.add("open");
}

function applySuggestion(command) {
    const current = elements.commandInput.value;
    const parts = current.split(/\s+/);

    parts[0] = command;

    elements.commandInput.value =
        `${parts.join(" ").trim()} `;

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

    if (
        (!state.selected ||
            !state.servers.some(
                (server) => server.id === state.selected
            )) &&
        state.servers[0]
    ) {
        state.selected = state.servers[0].id;
    }

    render();
}

async function serverAction(action) {
    const server = selectedServer();

    if (!server) {
        return;
    }

    const result = await api(
        `/api/servers/${server.id}/${action}`,
        { method: "POST" }
    );

    await refresh();

    return result;
}

async function loadPlayers() {
    const server = selectedServer();

    if (!server) {
        return;
    }

    const payload = await api(
        `/api/servers/${server.id}/players`
    );

    state.players = payload.players;
    state.playersServerId = server.id;

    renderPlayers();
}

async function loadPersistentLogs() {
    const server = selectedServer();

    if (!server) {
        return;
    }

    const payload = await api(
        `/api/servers/${server.id}/logs`
    );

    state.logs = payload.entries || [];
    state.logServerId = server.id;

    elements.consoleLogSource.textContent =
        payload.file ||
        server.logFile ||
        "logs/latest.log";

    renderLogs();
}

async function runPlayerAction(action, player = "") {
    const server = selectedServer();

    if (!server) {
        return;
    }

    const payload = await api(
        `/api/servers/${server.id}/player-action`,
        {
            method: "POST",
            body: { action, player }
        }
    );

    state.players = payload.players;
    state.playersServerId = server.id;

    renderPlayers();
}

function parentPath(path) {
    const parts = String(path || "")
        .split("/")
        .filter(Boolean);

    parts.pop();

    return parts.join("/");
}

async function loadFiles(path = state.filePath) {
    const server = selectedServer();

    if (!server) {
        return;
    }

    elements.fileList.innerHTML = `
    <div class="file-item">
      <span>Cargando...</span>
      <span></span>
    </div>
  `;

    const payload = await api(
        `/api/servers/${server.id}/files?path=${encodeURIComponent(path || "")
        }`
    );

    state.filePath = payload.path || "";
    state.currentFile = null;

    elements.filePathLabel.textContent = state.filePath
        ? `/${state.filePath}`
        : "/";

    elements.upFilesBtn.disabled = !state.filePath;
    elements.fileEditorPanel.hidden = true;

    const entries = payload.entries
        .map(
            (entry) => `
        <button
          class="file-item"
          data-file-path="${escapeHtml(entry.path)}"
          data-directory="${entry.directory}"
        >
          <span class="file-name">
            ${entry.directory
                    ? `
                  <svg
                    class="icon"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
                    />
                  </svg>
                `
                    : `
                  <svg
                    class="icon"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5Z"
                    />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                `
                }

            <span>${escapeHtml(entry.name)}</span>
          </span>

          <span class="file-meta">
            ${entry.directory
                    ? "Carpeta"
                    : `${Math.round(entry.size / 1024)} KB`
                }
          </span>
        </button>
      `
        )
        .join("");

    elements.fileList.innerHTML =
        entries ||
        `<div class="player-empty">Esta carpeta está vacía.</div>`;
}

async function openFile(path) {
    const server = selectedServer();

    const payload = await api(
        `/api/servers/${server.id}/file?path=${encodeURIComponent(path)
        }`
    );

    state.currentFile = payload.path;
    elements.fileEditorPanel.hidden = false;
    elements.fileEditorTitle.textContent = payload.path;
    elements.fileEditorStatus.textContent =
        `${Math.round(payload.size / 1024)} KB`;

    elements.fileEditorContent.value = payload.content;
}

async function saveCurrentFile() {
    const server = selectedServer();

    if (!state.currentFile) {
        return;
    }

    elements.fileEditorStatus.textContent = "Guardando...";

    const payload = await api(
        `/api/servers/${server.id}/file?path=${encodeURIComponent(state.currentFile)
        }`,
        {
            method: "PUT",
            body: {
                content: elements.fileEditorContent.value
            }
        }
    );

    elements.fileEditorStatus.textContent =
        `Guardado (${Math.round(payload.size / 1024)} KB)`;

    notify("Archivo guardado correctamente.");
}

function downloadCurrentFile() {
    const server = selectedServer();

    if (!state.currentFile) {
        return;
    }

    window.open(
        `/api/servers/${server.id}/download?path=${encodeURIComponent(state.currentFile)
        }`,
        "_blank"
    );
}

function renderProperties() {
    const data = state.properties;

    if (!data) {
        elements.propertiesForm.innerHTML = `
      <div class="property-empty">
        Carga las propiedades del servidor.
      </div>
    `;
        return;
    }

    elements.propertiesStatus.textContent = data.file;

    elements.propertiesForm.innerHTML = data.fields
        .map((field) => {
            const value = field.value ?? "";

            const description = field.description
                ? `<small>${escapeHtml(field.description)}</small>`
                : "";

            if (field.type === "select") {
                const options = field.options
                    .map(
                        (option) => `
              <option
                value="${escapeHtml(option)}"
                ${option === value ? "selected" : ""}
              >
                ${escapeHtml(option)}
              </option>
            `
                    )
                    .join("");

                return `
          <label class="property-field">
            <span>${escapeHtml(field.label)}</span>

            <select
              data-property-key="${escapeHtml(field.key)}"
            >
              ${options}
            </select>

            ${description}
          </label>
        `;
            }

            if (field.type === "boolean") {
                return `
          <label class="property-toggle">
            <input
              data-property-key="${escapeHtml(field.key)}"
              type="checkbox"
              ${value === "true" ? "checked" : ""}
            >

            <span>${escapeHtml(field.label)}</span>
            ${description}
          </label>
        `;
            }

            const numberAttrs =
                field.type === "number"
                    ? `type="number" min="${field.min ?? ""}" max="${field.max ?? ""}"`
                    : `type="text"`;

            return `
        <label class="property-field">
          <span>${escapeHtml(field.label)}</span>

          <input
            data-property-key="${escapeHtml(field.key)}"
            ${numberAttrs}
            value="${escapeHtml(value)}"
          >

          ${description}
        </label>
      `;
        })
        .join("");
}

async function loadProperties() {
    const server = selectedServer();

    if (!server) {
        return;
    }

    elements.propertiesStatus.textContent = "Cargando...";

    state.properties = await api(
        `/api/servers/${server.id}/properties`
    );

    renderProperties();
}

async function saveProperties() {
    const server = selectedServer();

    if (!server) {
        return;
    }

    const values = {};

    for (
        const input of elements.propertiesForm.querySelectorAll(
            "[data-property-key]"
        )
    ) {
        values[input.dataset.propertyKey] =
            input.type === "checkbox"
                ? String(input.checked)
                : input.value;
    }

    elements.propertiesStatus.textContent = "Guardando...";

    state.properties = await api(
        `/api/servers/${server.id}/properties`,
        {
            method: "PUT",
            body: { values }
        }
    );

    renderProperties();

    elements.propertiesStatus.textContent =
        "Guardado. Reinicia el servidor para aplicar la mayoría de cambios.";

    notify("Propiedades guardadas. Reinicia para aplicarlas.");
}

function ramValueToNumber(value) {
    const match = String(value || "").match(/^(\d+)/);

    return match ? Number(match[1]) : "";
}

function renderRam() {
    const data = state.ram;
    const memory = data?.memory || state.memory;

    if (!data) {
        elements.ramStatus.textContent =
            "Carga la configuración de RAM.";

        elements.ramSystem.textContent = memory
            ? `${memory.totalGb} GiB total / ${memory.availableGb} GiB libre ahora`
            : "--";

        return;
    }

    elements.ramStatus.textContent = data.file;

    elements.ramSystem.textContent =
        `${memory.totalGb} GiB total / ${memory.availableGb} GiB libre ahora`;

    elements.ramCurrent.textContent =
        `${data.minRam || "--"} / ${data.maxRam || "--"}`;

    elements.ramRecommended.textContent =
        `${memory.recommendedMinGb}G / ${memory.recommendedMaxGb}G`;

    elements.minRamInput.value = ramValueToNumber(
        data.minRam || `${memory.recommendedMinGb}G`
    );

    elements.maxRamInput.value = ramValueToNumber(
        data.maxRam || `${memory.recommendedMaxGb}G`
    );

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

    state.ram = await api(
        `/api/servers/${server.id}/ram`
    );

    renderRam();
}

async function saveRam() {
    const server = selectedServer();

    if (!server) {
        return;
    }

    elements.ramStatus.textContent = "Guardando...";

    state.ram = await api(
        `/api/servers/${server.id}/ram`,
        {
            method: "PUT",
            body: {
                minGb: Number(elements.minRamInput.value),
                maxGb: Number(elements.maxRamInput.value)
            }
        }
    );

    if (state.ram.server) {
        upsertServer(state.ram.server);
    }

    render();
    renderRam();

    elements.ramStatus.textContent =
        "Guardado. Reinicia el servidor para usar la nueva RAM.";

    notify("Asignación de RAM guardada.");
}

async function saveAutomation() {
    const server = selectedServer();

    if (!server) {
        return;
    }

    elements.automationStatus.textContent = "Guardando...";

    const payload = await api(
        `/api/servers/${server.id}/automation`,
        {
            method: "PUT",
            body: {
                backupSchedule:
                    elements.settingBackupSchedule.value,

                notifyWebhookUrl:
                    elements.settingNotifyWebhookUrl.value,

                autoRestart:
                    elements.settingAutoRestart.checked
            }
        }
    );

    if (payload.server) {
        upsertServer(payload.server);
    }

    state.automationDirty = false;

    render();

    elements.automationStatus.textContent =
        "Automatización guardada";

    notify("Automatización guardada.");
}

function openNewInstanceDialog() {
    elements.newInstanceStatus.textContent =
        "Registra una carpeta de server pack existente.";

    elements.newInstanceForm.reset();

    elements.newInstanceForm.elements.command.value =
        "bash start.sh";

    elements.newInstanceForm.elements.port.value =
        nextAvailablePort();

    elements.importSourcePath.value = "";
    elements.importBrowserPanel.hidden = true;
    elements.importBrowserList.innerHTML = "";
    elements.importBrowserPath.textContent = "/";
    elements.importBrowserUpBtn.disabled = true;
    elements.cancelImportBtn.hidden = true;
    hideImportProgress();

    if (
        typeof elements.newInstanceDialog.showModal === "function"
    ) {
        elements.newInstanceDialog.showModal();
    } else {
        elements.newInstanceDialog.setAttribute("open", "");
    }
}

function closeNewInstanceDialog() {
    elements.newInstanceDialog.close();
}

function nextAvailablePort() {
    const used = new Set(
        state.servers.map((server) => Number(server.port))
    );

    let port = 25566;

    while (used.has(port)) {
        port += 1;
    }

    return port;
}

async function createInstance() {
    const formData = new FormData(
        elements.newInstanceForm
    );

    const body = Object.fromEntries(formData.entries());

    elements.newInstanceStatus.textContent = "Guardando...";

    const server = await api("/api/servers", {
        method: "POST",
        body
    });

    upsertServer(server);

    state.selected = server.id;

    clearServerScopedState();
    render();
    closeNewInstanceDialog();

    await refresh();

    notify("Instancia agregada correctamente.");
}

async function importInstance() {
    const formData = new FormData(
        elements.newInstanceForm
    );

    const body = Object.fromEntries(formData.entries());
    body.sourcePath = elements.importSourcePath.value.trim();

    if (!body.sourcePath) {
        throw new Error("Elige una carpeta o archivo .zip para importar.");
    }

    elements.importInstanceBtn.setAttribute("aria-busy", "true");
    elements.importInstanceBtn.disabled = true;
    elements.newInstanceStatus.textContent = "Importando pack...";
    showImportProgress();

    try {
        const payload = await api("/api/import-server", {
            method: "POST",
            body
        });

        if (payload.job) {
            state.importJobId = payload.job.id;
            elements.cancelImportBtn.hidden = false;
            updateImportProgress(payload.job);
            await waitForImportJob(payload.job.id);
            return;
        }

        if (payload.server) {
            upsertServer(payload.server);
            state.selected = payload.server.id;
        }

        clearServerScopedState();
        render();
        closeNewInstanceDialog();

        await refresh();

        notify("Pack importado como instancia.");
    } finally {
        if (!state.importJobId) {
            finishImportProgress();
        }
    }
}

function showImportProgress() {
    elements.importProgress.hidden = false;
    elements.importProgressTitle.textContent = "Importando pack";
    elements.importProgressDetail.textContent =
        "Iniciando trabajo de importación...";
    elements.importProgressBar.style.width = "4%";
}

function updateImportProgress(job) {
    const percent = Math.max(4, Number(job.percent || 0));

    elements.importProgress.hidden = false;
    elements.importProgressTitle.textContent =
        job.status === "complete"
            ? "Importación completada"
            : "Importando pack";
    elements.importProgressDetail.textContent =
        job.message || "Trabajando...";
    elements.importProgressBar.style.width = `${Math.min(100, percent)}%`;
    elements.newInstanceStatus.textContent =
        job.message || "Importando pack...";
}

function hideImportProgress() {
    elements.importProgress.hidden = true;
    elements.importProgressTitle.textContent = "Preparando importación";
    elements.importProgressDetail.textContent =
        "Esto puede tardar varios minutos en packs grandes.";
    elements.importProgressBar.style.width = "0%";
}

function finishImportProgress() {
    state.importJobId = null;
    elements.cancelImportBtn.hidden = true;
    elements.importInstanceBtn.removeAttribute("aria-busy");
    elements.importInstanceBtn.disabled = false;
    hideImportProgress();
}

async function waitForImportJob(jobId) {
    return new Promise((resolve, reject) => {
        const poll = async () => {
            try {
                const payload = await api(`/api/import-jobs/${jobId}`);
                const job = payload.job;

                updateImportProgress(job);

                if (job.status === "running") {
                    return;
                }

                clearInterval(state.importPollTimer);
                state.importPollTimer = null;

                if (job.status === "complete") {
                    if (job.result?.server) {
                        upsertServer(job.result.server);
                        state.selected = job.result.server.id;
                    }

                    clearServerScopedState();
                    render();
                    closeNewInstanceDialog();

                    await refresh();

                    notify("Pack importado como instancia.");
                    finishImportProgress();
                    resolve(job);
                    return;
                }

                finishImportProgress();
                reject(new Error(job.error || "La importación no terminó correctamente."));
            } catch (error) {
                clearInterval(state.importPollTimer);
                state.importPollTimer = null;
                finishImportProgress();
                reject(error);
            }
        };

        state.importPollTimer = setInterval(poll, 1200);
        poll();
    });
}

async function cancelImport() {
    if (!state.importJobId) {
        return;
    }

    elements.cancelImportBtn.disabled = true;

    try {
        const payload = await api(`/api/import-jobs/${state.importJobId}/cancel`, {
            method: "POST"
        });

        updateImportProgress(payload.job);
        notify("Importación cancelada.");
    } finally {
        if (state.importPollTimer) {
            clearInterval(state.importPollTimer);
            state.importPollTimer = null;
        }
        elements.cancelImportBtn.disabled = false;
        finishImportProgress();
    }
}

async function loadImportBrowser(path = "") {
    elements.importBrowserPanel.hidden = false;
    elements.importBrowserList.innerHTML = `
        <div class="import-browser-empty">Cargando...</div>
    `;

    const query = path ? `?path=${encodeURIComponent(path)}` : "";
    const payload = await api(`/api/import-browser${query}`);

    elements.importBrowserPath.textContent = payload.path;
    elements.importBrowserUpBtn.disabled = !payload.parent;
    elements.importBrowserUpBtn.dataset.path = payload.parent || "";
    elements.useCurrentImportFolderBtn.dataset.path = payload.path;

    elements.importBrowserList.innerHTML = payload.entries.length
        ? payload.entries
            .map(
                (entry) => `
                    <button
                        class="import-browser-item"
                        type="button"
                        data-path="${escapeHtml(entry.path)}"
                        data-directory="${entry.directory}"
                    >
                        <span class="file-name">
                            ${entry.directory
                                ? `
                                    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>
                                `
                                : `
                                    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5Z"/><polyline points="14 2 14 8 20 8"/></svg>
                                `
                            }
                            <span>${escapeHtml(entry.name)}</span>
                        </span>
                        <span class="file-meta">
                            ${entry.directory
                                ? "Carpeta"
                                : `${Math.round(entry.size / 1024)} KB`
                            }
                        </span>
                    </button>
                `
            )
            .join("")
        : `<div class="import-browser-empty">No hay carpetas ni archivos .zip aqui.</div>`;
}

function useImportSourcePath(path) {
    elements.importSourcePath.value = path;
    elements.newInstanceStatus.textContent =
        "Ruta seleccionada. Puedes importar el pack.";
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
    setSocketStatus("connecting");

    const protocol =
        location.protocol === "https:" ? "wss" : "ws";

    const socket = new WebSocket(
        `${protocol}://${location.host}/ws`
    );

    socket.addEventListener("open", () => {
        setSocketStatus("connected");
    });

    socket.addEventListener("message", (event) => {
        let message;

        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }

        if (message.type === "hello") {
            state.servers = message.payload.servers;

            if (
                (!state.selected ||
                    !state.servers.some(
                        (server) => server.id === state.selected
                    )) &&
                state.servers[0]
            ) {
                state.selected = state.servers[0].id;
            }

            render();
        }

        if (
            message.type === "log" &&
            message.payload.serverId === state.selected
        ) {
            state.logs.push(message.payload);
            renderLogs();
        }

        if (message.type === "server-state") {
            const server = state.servers.find(
                (item) =>
                    item.id === message.payload.serverId
            );

            if (server) {
                server.running = message.payload.running;
                server.pid = message.payload.pid;
                server.usage = message.payload.usage;
                render();
            }
        }

        if (
            message.type === "players" &&
            message.payload.serverId === state.selected
        ) {
            state.players = message.payload.players;
            state.playersServerId =
                message.payload.serverId;

            const server = state.servers.find(
                (item) =>
                    item.id === message.payload.serverId
            );

            if (server) {
                server.players = message.payload.players;
            }

            renderPlayers();
        }
    });

    socket.addEventListener("close", () => {
        setSocketStatus("disconnected");
        setTimeout(connectSocket, 1500);
    });

    socket.addEventListener("error", () => {
        socket.close();
    });
}

function activateView(button) {
    document
        .querySelectorAll(".nav-item")
        .forEach((item) => {
            const active = item === button;

            item.classList.toggle("active", active);

            if (active) {
                item.setAttribute("aria-current", "page");
            } else {
                item.removeAttribute("aria-current");
            }
        });

    document
        .querySelectorAll(".view")
        .forEach((view) => {
            view.classList.toggle(
                "active",
                view.id === button.dataset.view
            );
        });
}

document
    .querySelectorAll(".nav-item")
    .forEach((button) => {
        button.addEventListener("click", () => {
            activateView(button);

            if (button.dataset.view === "files") {
                loadFiles().catch((error) => {
                    elements.fileList.innerHTML = `
            <div class="file-item">
              <span>${escapeHtml(error.message)}</span>
              <span></span>
            </div>
          `;

                    reportError(error);
                });
            }

            if (button.dataset.view === "properties") {
                loadProperties().catch((error) => {
                    elements.propertiesStatus.textContent =
                        error.message;

                    elements.propertiesForm.innerHTML = "";

                    reportError(error);
                });
            }

            if (button.dataset.view === "performance") {
                loadRam().catch((error) => {
                    elements.ramStatus.textContent =
                        error.message;

                    reportError(error);
                });
            }

            if (button.dataset.view === "console") {
                loadPersistentLogs().catch(reportError);
            }
        });
    });

async function runServerControl(
    button,
    action,
    successMessage
) {
    button.setAttribute("aria-busy", "true");
    button.disabled = true;

    try {
        const result = await serverAction(action);

        notify(
            typeof successMessage === "function"
                ? successMessage(result)
                : successMessage
        );
    } catch (error) {
        reportError(error);
    } finally {
        button.removeAttribute("aria-busy");
        render();
    }
}

elements.startBtn.addEventListener("click", () =>
    runServerControl(
        elements.startBtn,
        "start",
        "Inicio solicitado."
    )
);

elements.stopBtn.addEventListener("click", () =>
    runServerControl(
        elements.stopBtn,
        "stop",
        "Apagado seguro solicitado."
    )
);

elements.restartBtn.addEventListener("click", () =>
    runServerControl(
        elements.restartBtn,
        "restart",
        "Reinicio programado."
    )
);

elements.backupBtn.addEventListener("click", () =>
    runServerControl(
        elements.backupBtn,
        "backup",
        (result) => `Backup creado en ${result.path}`
    )
);

elements.serverSelect.addEventListener("change", () => {
    state.selected = elements.serverSelect.value;

    clearServerScopedState();
    render();

    reloadActiveView().catch(reportError);
});

elements.newInstanceBtn.addEventListener(
    "click",
    openNewInstanceDialog
);

$("#closeNewInstanceBtn").addEventListener(
    "click",
    closeNewInstanceDialog
);

$("#cancelNewInstanceBtn").addEventListener(
    "click",
    closeNewInstanceDialog
);

elements.newInstanceForm.addEventListener(
    "submit",
    (event) => {
        event.preventDefault();

        createInstance().catch((error) => {
            elements.newInstanceStatus.textContent =
                error.message;

            reportError(error);
        });
    }
);

elements.importInstanceBtn.addEventListener(
    "click",
    () => {
        importInstance().catch((error) => {
            elements.newInstanceStatus.textContent =
                error.message;

            reportError(error);
        });
    }
);

elements.cancelImportBtn.addEventListener(
    "click",
    () => {
        cancelImport().catch((error) => {
            elements.newInstanceStatus.textContent =
                error.message;

            reportError(error);
        });
    }
);

elements.browseImportSourceBtn.addEventListener(
    "click",
    () => {
        const currentPath = elements.importSourcePath.value.trim();

        loadImportBrowser(currentPath).catch((error) => {
            elements.newInstanceStatus.textContent =
                error.message;

            reportError(error);
        });
    }
);

elements.importBrowserUpBtn.addEventListener(
    "click",
    () => {
        loadImportBrowser(elements.importBrowserUpBtn.dataset.path || "")
            .catch(reportError);
    }
);

elements.useCurrentImportFolderBtn.addEventListener(
    "click",
    () => {
        const path = elements.useCurrentImportFolderBtn.dataset.path;

        if (path) {
            useImportSourcePath(path);
        }
    }
);

elements.importBrowserList.addEventListener(
    "click",
    (event) => {
        const item = event.target.closest("[data-path]");

        if (!item) {
            return;
        }

        const path = item.dataset.path;

        if (item.dataset.directory === "true") {
            loadImportBrowser(path).catch(reportError);
            return;
        }

        useImportSourcePath(path);
    }
);

$("#refreshPlayersBtn").addEventListener(
    "click",
    () =>
        runPlayerAction("refresh")
            .then(() => {
                notify("Lista de jugadores actualizada.");
            })
            .catch(reportError)
);

$("#refreshFilesBtn").addEventListener(
    "click",
    () => loadFiles().catch(reportError)
);

elements.upFilesBtn.addEventListener(
    "click",
    () =>
        loadFiles(parentPath(state.filePath))
            .catch(reportError)
);

elements.fileList.addEventListener("click", (event) => {
    const item = event.target.closest("[data-file-path]");

    if (!item) {
        return;
    }

    const path = item.dataset.filePath;

    if (item.dataset.directory === "true") {
        loadFiles(path).catch(reportError);
    } else {
        openFile(path).catch(reportError);
    }
});

elements.saveFileBtn.addEventListener("click", () => {
    saveCurrentFile().catch((error) => {
        elements.fileEditorStatus.textContent =
            error.message;

        reportError(error);
    });
});

elements.downloadFileBtn.addEventListener(
    "click",
    downloadCurrentFile
);

$("#reloadPropertiesBtn").addEventListener(
    "click",
    () => loadProperties().catch(reportError)
);

$("#reloadRamBtn").addEventListener(
    "click",
    () => loadRam().catch(reportError)
);

$("#reloadLogsBtn").addEventListener(
    "click",
    () => loadPersistentLogs().catch(reportError)
);

$("#saveAutomationBtn").addEventListener(
    "click",
    () => {
        saveAutomation().catch((error) => {
            elements.automationStatus.textContent =
                error.message;

            reportError(error);
        });
    }
);

$("#recommendedRamBtn").addEventListener(
    "click",
    () => {
        const memory =
            state.ram?.memory || state.memory;

        if (!memory) {
            return;
        }

        elements.minRamInput.value =
            memory.recommendedMinGb;

        elements.maxRamInput.value =
            memory.recommendedMaxGb;
    }
);

$("#propertiesForm").addEventListener(
    "submit",
    (event) => {
        event.preventDefault();
        saveProperties().catch(reportError);
    }
);

$("#ramForm").addEventListener(
    "submit",
    (event) => {
        event.preventDefault();
        saveRam().catch(reportError);
    }
);

$("#clearConsoleBtn").addEventListener(
    "click",
    () => {
        state.logs = [];
        renderLogs();

        notify("Vista de consola limpiada.");
    }
);

[
    elements.settingBackupSchedule,
    elements.settingNotifyWebhookUrl,
    elements.settingAutoRestart
].forEach((input) => {
    input.addEventListener("input", () => {
        state.automationDirty = true;

        elements.automationStatus.textContent =
            "Cambios sin guardar";
    });

    input.addEventListener("change", () => {
        state.automationDirty = true;

        elements.automationStatus.textContent =
            "Cambios sin guardar";
    });
});

elements.playerList.addEventListener(
    "click",
    (event) => {
        const button = event.target.closest(
            "[data-player-action]"
        );

        if (!button) {
            return;
        }

        const action = button.dataset.playerAction;
        const player = button.dataset.player;

        if (
            (action === "ban" || action === "kick") &&
            !confirm(
                `Confirmar ${button.textContent
                    .toLowerCase()} a ${player}`
            )
        ) {
            return;
        }

        runPlayerAction(action, player)
            .then(() => {
                notify(`Acción aplicada a ${player}.`);
            })
            .catch(reportError);
    }
);

$("#commandForm").addEventListener(
    "submit",
    async (event) => {
        event.preventDefault();

        const command =
            elements.commandInput.value.trim();

        if (!command) {
            return;
        }

        const server = selectedServer();

        try {
            await api(
                `/api/servers/${server.id}/command`,
                {
                    method: "POST",
                    body: { command }
                }
            );

            elements.commandInput.value = "";
            renderSuggestions();
        } catch (error) {
            reportError(error);
        }
    }
);

elements.commandInput.addEventListener(
    "input",
    () => {
        state.suggestionIndex = -1;
        renderSuggestions();
    }
);

elements.commandInput.addEventListener(
    "keydown",
    (event) => {
        const items = [
            ...elements.suggestions.querySelectorAll(
                ".suggestion"
            )
        ];

        if (event.key === "Tab") {
            if (
                completeSuggestion(
                    event.shiftKey ? -1 : 1
                )
            ) {
                event.preventDefault();
            }

            return;
        }

        if (
            event.key === "Enter" &&
            state.suggestionIndex >= 0 &&
            items[state.suggestionIndex]
        ) {
            event.preventDefault();

            applySuggestion(
                items[state.suggestionIndex].dataset.command
            );

            return;
        }

        if (
            event.key === "ArrowDown" &&
            items.length
        ) {
            event.preventDefault();

            state.suggestionIndex = Math.min(
                items.length - 1,
                state.suggestionIndex + 1
            );

            renderSuggestions();
        }

        if (
            event.key === "ArrowUp" &&
            items.length
        ) {
            event.preventDefault();

            state.suggestionIndex = Math.max(
                0,
                state.suggestionIndex - 1
            );

            renderSuggestions();
        }
    }
);

elements.suggestions.addEventListener(
    "mousedown",
    (event) => {
        const item = event.target.closest(".suggestion");

        if (item) {
            applySuggestion(item.dataset.command);
        }
    }
);

refresh().catch(reportError);
connectSocket();
