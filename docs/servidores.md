# Servidores, hardware y ciberseguridad

Diseño acordado con el usuario. Estado: **las 8 fases están hechas** (falta el balance fino con playtest). Las decisiones y su porqué están resumidas en `docs/DECISIONES.md`.

## El ciclo

```
Vender en la tienda → $ → Comprar piezas en línea → Llegan en el camión
      ↑                                                     ↓
 Bug bounty $        Montar el servidor a mano (1ª persona) ←┘
      ↑                                                     ↓
 Denunciar la IP real ← Rastrear (nmap…) ← Leer los logs ← Ataque
                                                            ↑
           Instalar Linux → Conectar robots por IP → Defender (antivirus, firewall)
```

**Los robots nunca hacen esta parte**: montar, configurar e investigar es trabajo de los jugadores.

## Decisiones del usuario

1. **Cuándo aparece**: justo después de la misión del inventario ("migración del proveedor"). Antes de programar a
   los robots, los jugadores **montan el primer servidor** (es el tutorial de montaje), instalan Linux y conectan a
   los robots. Por eso **la primera noche dura 20 minutos** (`NIGHT.firstMs`); las demás, 10.
2. **Los ataques solo frenan** (roban CPU, saturan la red). No borran código ni datos del jugador.
3. **Online**: mientras uno monta el servidor, el otro sigue en la tienda sin problema.
4. **La base de datos no vive en ningún servidor** (por ahora no gasta CPU de los servidores).
5. Linux **simulado** (terminal propia en TypeScript con comandos y salidas reales), no un Linux emulado.
6. Sin servidor (o con el servidor apagado), los robots **se detienen**.
7. El rastreo de atacantes **no siempre es igual**: varios casos y varias técnicas (ver §7).

## 1. Recursos de un servidor (fase 1: hecho)

| Recurso | En el juego | Si se satura |
|---|---|---|
| **CPU** (núcleos × velocidad) | Cada núcleo hace `CPU_OPS[nivel]` operaciones Python por tick. Un robot usa como mucho un núcleo. | Desde 80% de carga todos los robots del servidor van más lento (hasta 2,5× al 100%): piensan y caminan menos veces por segundo. |
| **RAM** | 0,5 GB el sistema + 0,5 GB por robot corriendo. | Un robot más no arranca ("no hay memoria RAM libre"). |
| **GPU** | Solo para comandos pesados futuros (visión, predicción). | Esos comandos tardan más. |
| **Temperatura** | Para el final (fase 8). | El servidor baja su velocidad solo. |

- `srv-01` (10.0.0.10) empieza con **1 núcleo y 2 GB**. Toño es 10.0.0.21 y Lupe 10.0.0.22.
- La lección: un `while True:` que pregunta sin `wait()` satura la CPU y frena **a los dos** robots; con `wait()` la
  carga es baja. Más núcleos compensan el mal código, pero cuestan plata.
- Ya no hay mejoras de CPU en el árbol de Mejoras: la CPU se mejora comprando piezas en TecnoMercado. La velocidad
  normal de cada robot sale del **tamaño de su código** (`codesize.ts`); el servidor solo la frena (carga, ataques, calor).
- Código: `servers.ts` (`shareCpu`, `slowdown`, `updateLoad`), `World.stepServer`, `World.attach`,
  `World.setServerOnline`. Números en `SERVER` (`config.ts`). Tests en `packages/sim/test/servers.test.ts`.

## 2. Tienda en línea ("TecnoMercado", ficticia)

Ventana tipo navegador. Se empieza con **un solo gabinete de rack** y la sala solo tiene espacio para uno: se amplía en Mejoras → Centro de datos ("Sala más grande": 2 racks; "Centro de datos": 3). Los otros dos gabinetes se compran ("Gabinete de rack
42U", $15.000) junto con sus piezas. Catálogo: gabinete de rack, placa madre, fuente, CPU (2/4/8 núcleos), RAM (4/8/16 GB), SSD,
GPU, tarjeta de red, cables de red y de poder, switch, ventiladores, aire acondicionado, licencia de antivirus,
protección anti-DDoS.

- Compatibilidad con solo dos reglas: el *socket* de la CPU coincide con el de la placa, y los vatios de la fuente
  alcanzan. La tienda avisa pero deja comprar (equivocarse cuesta plata, no bloquea).
- Entrega: **a la mañana siguiente en el camión** (se reutiliza la cinemática del distribuidor); las cajas aparecen
  en el almacén. El primer servidor llega con la entrega inicial.

## 3. Montaje en primera persona

Clic en el rack → la cámara hace zoom al chasis abierto. Las piezas están en una bandeja; se arrastran y **encajan
solas** en su lugar (el lugar correcto brilla; el equivocado no deja y parpadea el correcto). Sin tornillos.

Pasos: placa madre → CPU (palanca) → disipador → RAM → SSD → fuente → GPU (si hay) → cables (24 pines, 8 pines de
CPU, poder del SSD, **red al switch**: se arrastra de puerto a puerto). Se cierra la tapa y se enciende: pantalla
POST con mensajes claros si falta algo ("No se detecta memoria RAM", "La fuente no alcanza: 450 W de 600 W").

## 4. Linux

1. Primer arranque: instalador en la terminal (nombre, usuario, contraseña).
2. Red: asignar la IP y probar con `ping 10.0.0.1`.
3. `apt install robot-agent` y `systemctl enable --now robot-agent`.
4. `ping 10.0.0.21` y `robot attach 10.0.0.21`: desde ahí, el código de Toño corre en ese servidor.

Comandos por etapas: `ls cd cat pwd clear help` · `top htop ps free nproc uptime df` · `kill systemctl` ·
`ip ping ssh` · `apt ufw` · `grep tail journalctl` · herramientas de investigación (§7).

Red local: 10.0.0.1 router · 10.0.0.10 srv-01 · 10.0.0.11 srv-02 · 10.0.0.21 Toño · 10.0.0.22 Lupe.

## 5. Ataques (solo frenan)

| Ataque | Qué se nota | Logs | Defensa |
|---|---|---|---|
| Escaneo de puertos | Nada (aviso previo) | `ufw.log` | Firewall (`ufw`) |
| Fuerza bruta SSH | Alerta de intentos de acceso | `auth.log` (*Failed password*) | Contraseña fuerte, `fail2ban`, llaves SSH |
| DDoS | Los robots se traban (red saturada) | `access.log`, `syslog` | Firewall, límite de conexiones, anti-DDoS de la tienda |
| Malware / minero | La CPU sube sin razón | Proceso raro en `top` | Antivirus (`clamscan`; actualizar con `freshclam`), `kill`, `apt upgrade` |

Más frecuentes con los días y si el servidor está expuesto (puertos abiertos, contraseña débil, sin actualizar).

## 6. Logs

Con la hora del juego: `/var/log/auth.log`, `/var/log/syslog`, `/var/log/ufw.log`, `/var/log/nginx/access.log`.
Se leen con `cat`, `tail -f`, `grep`, `journalctl`.

## 7. Rastreo del atacante: cada caso es distinto

`CASO = tipo de ataque + escondites (0–3 capas: botnet, VPN, proxy, C2, dominio) + error del atacante + señuelos`

| # | Técnica (el error del atacante) | Cómo se resuelve | Herramientas |
|---|---|---|---|
| 1 | Se le cayó la VPN | La única conexión de `auth.log` que no viene de la VPN | `grep`, `whois`, `geoip` |
| 2 | Malware que "habla" | Leer los textos del binario y seguir el dominio del C2 | `top`, `ps`, `strings`, `dig`, `whois` |
| 3 | Conexión en vivo | Con qué IP habla el proceso ahora | `netstat -tunap`, `ss`, `tcpdump` |
| 4 | Inyección SQL a la tienda en línea | `' OR 1=1 --` en `access.log`, contar por IP | `grep`, `sort`, `uniq -c`, `awk` |
| 5 | Correo de phishing | Cabecera `Received: from` | Bandeja de correo del juego |
| 6 | Se delató en un foro | Su usuario de `auth.log` buscado en el foro (OSINT) | `grep`, navegador del juego |
| 7 | Trampa (honeypot) | Esperar a que vuelva y ver desde dónde descarga | `apt install cowrie`, `tail -f` |
| 8 | Horario sospechoso | Cruzar horas de ataque con la zona horaria de 4 sospechosos | `awk`, `sort`, `geoip` |
| 9 | El enemigo está adentro | Un aparato infectado en la red local: desconectarlo y rastrear quién lo controla | `nmap -sn 10.0.0.0/24`, `nmap -sV` |
| 10 | Dominio registrado | El registro guarda la IP de creación | `dig`, `whois dominio` |

- **Rotación**: la misma técnica no se repite en dos casos seguidos; se prefieren las no vistas.
- **Señuelos** (desde nivel medio): bandera falsa (IP de otro plantada), logs borrados (recuperar de `*.1` o
  `journalctl`), IP dinámica (si se demora, cambia).
- **Niveles**: fácil (0–1 capas, sin señuelos), medio (1–2, uno), difícil (2–3, dos).
- **Ayudas**: la primera vez de cada técnica, una pista del técnico; hasta 3 pistas por caso, cada una −20% del bounty.
- **Siempre tiene solución**: el generador usa una semilla (igual para los dos jugadores en online). Un solucionador
  automático en los tests resuelve cada técnica solo con comandos de la terminal (como un jugador) en 40 semillas y
  los 3 niveles; si una técnica dejara un caso sin solución, el test falla.
- **IPs ficticias**: solo rangos de documentación (192.0.2.x, 198.51.100.x, 203.0.113.x). Las herramientas solo
  funcionan dentro de la red del juego.

## 8. Denuncia y bug bounty

Página del juego **"Centro de Denuncias Cibernéticas"** (ficticia, sin imitar a una entidad real). Formulario: tipo
de ataque, fecha, IP del atacante y (opcional, da bono) la línea del log.

- IP real → caso cerrado, **bug bounty** según dificultad y capas, sube la reputación.
- IP de la botnet o de la VPN → rechazada con el motivo (también es una pista).
- 3 intentos por caso; acusar a un inocente baja la reputación; los casos vencen a los pocos días.

## Arquitectura

| Pieza | Dónde |
|---|---|
| `servers.ts` (hecho) | `packages/sim`: hardware, CPU repartida, carga, RAM |
| `network.ts` | `packages/sim`: IPs, red local e "internet" (botnets, VPNs, atacantes) |
| `shell/` | `packages/sim`: terminal simulada, sistema de archivos virtual, un comando por archivo |
| `security.ts` | `packages/sim`: generador de ataques y casos con semilla + solucionador |
| Tienda, denuncias, terminal (xterm.js), correo, foro | `apps/web`: ventanas flotantes |
| Montaje | `apps/web`: escena Three.js en primera persona (zoom, arrastrar y encajar) |

## Fases

| # | Fase | Estado |
|---|---|---|
| 1 | Modelo de servidores: CPU repartida, robots lentos, RAM, sin servidor no corren | **Hecho** |
| 2 | Terminal + Linux básico + logs | **Hecho** |
| 3 | Red e IPs: `ping`, `ssh`, `robot attach` | **Hecho** |
| 4 | Tienda en línea + entrega en el camión | **Hecho** |
| 5 | Montaje en primera persona (tutorial con el primer servidor) | **Hecho** |
| 6 | Ataques y defensas | **Hecho** |
| 7 | Rastreo + denuncia + bounty | **Hecho** |
| 8 | GPU (scan_item ×2), temperatura (ventiladores, aire acondicionado) | **Hecho**; el balance fino queda para el playtest |

## Dónde está cada cosa (código)

| Qué | Archivo |
|---|---|
| Piezas, compatibilidad, montaje, POST | `packages/sim/src/hardware.ts` · `World.installPart/connectCable/powerOn/order/deliver` |
| Servidor (CPU, RAM, temperatura, malware, DDoS) | `packages/sim/src/servers.ts` · `World.stepServer` |
| Terminal: intérprete, instalador, comandos, archivos | `packages/sim/src/shell/` (`shell.ts`, `commands.ts`, `system.ts`, `vfs.ts`) |
| Red ficticia (IPs de documentación, whois, dominios) | `packages/sim/src/network.ts` |
| Ataques, 10 técnicas, casos, denuncia, pistas | `packages/sim/src/security.ts` · `World.launchAttack/report/hint/stepSecurity` |
| Números de balance | `SERVER`, `SECURITY` en `packages/sim/src/config.ts`; precios en `PARTS`/`SERVICES` |
| Cuarto de servidores 3D (racks, luces, globito) | `apps/web/src/store3d.ts` (`buildServerRoom`, `focusRack`) |
| Montaje en primera persona | `apps/web/src/assembly.ts` |
| Ventana de terminal | `apps/web/src/terminal.ts` |
| Navegador (TecnoMercado, Denuncias, Foro) | `apps/web/src/browser.ts` |
| Misión "Monta tu servidor" y flujo de la primera noche | `apps/web/src/main.ts` (`startServerMission`, `onRack`) |
| Tests (el solucionador resuelve cada técnica solo con la terminal, 40 semillas × 3 niveles) | `packages/sim/test/security.test.ts`, `shell.test.ts`, `servers.test.ts` |
