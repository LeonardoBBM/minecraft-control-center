# Minecraft Control Center

Panel local para controlar servidores de Minecraft con consola en vivo y autocompletado de comandos.

## Funciones actuales

- Dashboard con estado, puerto, RAM objetivo y PID.
- Inicio, apagado, reinicio y backup manual.
- Consola en vivo con WebSocket.
- Input de comandos con autocompletado.
- Lista inicial de comandos comunes de Minecraft.
- Explorador de archivos de primer nivel.
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
/home/leonardo/Escritorio/Prominence_II_Hasturian_Era_Server_Pack_v3.9.27
```

con comando:

```bash
bash start.sh
```

## Seguridad

El panel escucha solo en `127.0.0.1`. No esta pensado para exponerse a internet sin autenticacion, HTTPS y un proxy seguro.

## Siguientes mejoras

- Editor visual de `server.properties`.
- Importador de server packs.
- Gestion de mods y datapacks.
- Backups programados.
- Usuarios/login.
- Estadisticas reales de CPU/RAM por proceso.
- Integracion opcional con servidores ya administrados por systemd o Crafty.
