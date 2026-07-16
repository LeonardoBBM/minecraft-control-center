# Minecraft Control Center

Panel local para controlar servidores de Minecraft con consola en vivo y autocompletado de comandos.

## Requisitos

- Node.js 20 o superior.
- `screen` instalado en Linux para supervisar las instancias de Minecraft.

## Funciones actuales

- Dashboard con estado, puerto, RAM objetivo y PID.
- Inicio, apagado, reinicio y backup manual.
- Consola en vivo con WebSocket.
- Input de comandos con autocompletado.
- Lista inicial de comandos comunes de Minecraft.
- Explorador de archivos de primer nivel.
- Editor visual de campos comunes de `server.properties`.
- Selector de instancias y registro de nuevos server packs existentes.
- Registro inicial para el server pack Prominence II existente.

## Uso

```bash
npm install
npm start
```

Luego abre:

```text
http://127.0.0.1:4545
```

## Autoarranque con systemd

El repo incluye una plantilla en:

```text
systemd/minecraft-control-center.service
```

Para instalarla en esta maquina:

```bash
sudo cp systemd/minecraft-control-center.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now minecraft-control-center.service
```

Comandos utiles:

```bash
systemctl status minecraft-control-center.service
journalctl -u minecraft-control-center.service -f
sudo systemctl restart minecraft-control-center.service
```

La plantilla mantiene `127.0.0.1:4545`, usa `User=leonardo`, `WorkingDirectory` apuntando a este repo y `Restart=on-failure`.

## Configuracion de servidores

Los servidores se registran en:

```text
data/servers.json
```

El registro inicial apunta a:

```text
/home/leonardo/.openclaw/workspace/minecraft-control-center/servers/prominence
```

con comando:

```bash
bash start.sh
```

Desde el boton **Nueva instancia** puedes registrar otro modpack ya descargado. El panel pide nombre, carpeta, comando, puerto, RAM opcional y notas. La carpeta debe existir; el panel no copia ni borra archivos del modpack.

## Control de procesos

El panel arranca cada servidor dentro de una sesion `screen` llamada `mc-<id-del-servidor>`. Esto permite que Minecraft siga supervisado aunque el proceso Node del panel se reinicie.

- Iniciar usa `screen -dmS`.
- Enviar comandos usa `screen -S <sesion> -X stuff`.
- Detener manda `stop` y, si la sesion no cierra, hace `screen -X quit` despues de un tiempo de gracia.
- La consola del panel lee `logs/latest.log` del servidor, no stdout directo de Node.

## Logs persistentes

Cada instancia usa el `logs/latest.log` de Minecraft como fuente persistente de consola. Al arrancar o reiniciar el panel se cargan las ultimas lineas disponibles desde disco, y la vista **Consola** tiene un boton **Recargar logs** para volver a leer ese archivo sin tocar el proceso del servidor.

## Automatizacion

Cada servidor puede definir:

- `backupSchedule`: cron simple de 5 campos, por ejemplo `0 4 * * *`.
- `autoRestart`: si es `true`, el panel intenta levantar de nuevo la sesion `screen` cuando detecta que termino sin un `stop` manual.
- `notifyWebhookUrl`: URL opcional para recibir eventos importantes.

El auto-restart espera 10 segundos y limita los reintentos a 3 en una ventana de 5 minutos para evitar ciclos de crash. La configuracion se puede editar desde la pestaña **Configuracion**.

## Notificaciones

Si una instancia tiene `notifyWebhookUrl`, el panel envia un `POST` JSON cuando detecta una caida inesperada, programa/falla un auto-restart o falla un backup programado. El payload tiene esta forma:

```json
{
  "event": "server_stopped_unexpectedly",
  "serverId": "prominence-ii",
  "serverName": "Prominence II - Hasturian Era",
  "message": "La sesion screen del servidor termino inesperadamente.",
  "at": "2026-07-16T08:00:00.000Z",
  "details": {}
}
```

## CPU/RAM real

Cuando una instancia esta corriendo, el panel busca los procesos hijos de la sesion `screen`, detecta el proceso Java si existe y calcula uso real leyendo `/proc`. El dashboard muestra CPU y RAM reales junto al PID de la sesion.

## File manager

La pestaña **Archivos** permite navegar subcarpetas dentro de la carpeta del servidor. Las rutas se resuelven contra `server.path` y se rechaza cualquier intento de salir de esa carpeta. Los archivos de texto menores a 1MB se pueden abrir, editar, guardar y descargar desde el panel.

## Seguridad

El panel escucha solo en `127.0.0.1`. No esta pensado para exponerse a internet sin autenticacion, HTTPS y un proxy seguro.

## Editor de `server.properties`

La pestaña **Propiedades** permite editar campos comunes como:

- `motd`
- `difficulty`
- `gamemode`
- `pvp`
- `white-list`
- `online-mode`
- `max-players`
- `server-port`
- `view-distance`
- `simulation-distance`

El guardado conserva comentarios y propiedades avanzadas del archivo. La mayoria de cambios requiere reiniciar el servidor.

## Siguientes mejoras

- Gestion de mods y datapacks.
- Backups programados.
- Usuarios/login.
- Estadisticas reales de CPU/RAM por proceso.
- Integracion opcional con servidores ya administrados por systemd o Crafty.
