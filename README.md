# Minecraft Control Center

Panel local para controlar servidores de Minecraft con consola en vivo y autocompletado de comandos.

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
