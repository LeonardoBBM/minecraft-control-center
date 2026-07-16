export const COMMANDS = [
  { command: "help", syntax: "help [comando]", description: "Muestra ayuda del servidor." },
  { command: "list", syntax: "list", description: "Muestra jugadores conectados." },
  { command: "say", syntax: "say <mensaje>", description: "Envía un mensaje global." },
  { command: "tell", syntax: "tell <jugador> <mensaje>", description: "Envía un mensaje privado." },
  { command: "op", syntax: "op <jugador>", description: "Da permisos de operador." },
  { command: "deop", syntax: "deop <jugador>", description: "Quita permisos de operador." },
  { command: "whitelist", syntax: "whitelist <on|off|add|remove|list|reload> [jugador]", description: "Administra la whitelist." },
  { command: "gamemode", syntax: "gamemode <survival|creative|adventure|spectator> [jugador]", description: "Cambia modo de juego." },
  { command: "difficulty", syntax: "difficulty <peaceful|easy|normal|hard>", description: "Cambia dificultad." },
  { command: "time", syntax: "time set <day|night|noon|midnight>", description: "Cambia la hora del mundo." },
  { command: "weather", syntax: "weather <clear|rain|thunder> [duracion]", description: "Cambia el clima." },
  { command: "tp", syntax: "tp <jugador> <destino>", description: "Teletransporta jugadores." },
  { command: "kick", syntax: "kick <jugador> [razon]", description: "Expulsa a un jugador." },
  { command: "ban", syntax: "ban <jugador> [razon]", description: "Banea a un jugador." },
  { command: "ban-ip", syntax: "ban-ip <ip|jugador> [razon]", description: "Banea una IP." },
  { command: "pardon", syntax: "pardon <jugador>", description: "Quita ban a un jugador." },
  { command: "pardon-ip", syntax: "pardon-ip <ip>", description: "Quita ban a una IP." },
  { command: "save-all", syntax: "save-all [flush]", description: "Guarda el mundo." },
  { command: "save-off", syntax: "save-off", description: "Desactiva guardado automático." },
  { command: "save-on", syntax: "save-on", description: "Activa guardado automático." },
  { command: "stop", syntax: "stop", description: "Apaga el servidor correctamente." },
  { command: "seed", syntax: "seed", description: "Muestra la semilla del mundo." },
  { command: "setworldspawn", syntax: "setworldspawn [x y z]", description: "Define spawn del mundo." },
  { command: "spawnpoint", syntax: "spawnpoint [jugador] [x y z]", description: "Define spawn de jugador." },
  { command: "gamerule", syntax: "gamerule <regla> [valor]", description: "Consulta o cambia gamerules." },
  { command: "effect", syntax: "effect give|clear <jugador> [efecto]", description: "Administra efectos." },
  { command: "give", syntax: "give <jugador> <item> [cantidad]", description: "Entrega items." },
  { command: "clear", syntax: "clear [jugador] [item]", description: "Limpia inventario." },
  { command: "playsound", syntax: "playsound <sonido> <fuente> <jugador>", description: "Reproduce un sonido." },
  { command: "reload", syntax: "reload", description: "Recarga datapacks/config compatible." }
];

export function completeCommand(input) {
  const normalized = input.trim().toLowerCase();
  if (!normalized) {
    return COMMANDS.slice(0, 8);
  }

  const prefixMatches = COMMANDS.filter((entry) => entry.command.startsWith(normalized));
  if (prefixMatches.length) {
    return prefixMatches.slice(0, 8);
  }

  return COMMANDS
    .filter((entry) => entry.command.includes(normalized) || entry.syntax.toLowerCase().includes(normalized))
    .slice(0, 8);
}
