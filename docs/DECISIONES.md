# Decisiones

Qué pidió el usuario y por qué está así. Antes de deshacer algo de esta lista, pregúntale al usuario.
(Este archivo se empezó el 2026-11-18; las decisiones anteriores están resumidas en `CLAUDE.md`, sección
"Reglas y preferencias del usuario".)

## Preparación de 10 minutos antes de abrir (2026-11-18)

**Pedido:** al pasar la primera parte (ordenar la base de datos y el inventario) y llegar a la tienda, los jugadores
tienen 10 minutos para escribir el código del cajero y del robot que surte los estantes. Si terminan antes, pueden
empezar, pero **tienen que votar los dos**. Si se pasan los 10 minutos, los clientes empiezan a llegar igual ("eso ya
es problema de ellos").

- El tiempo es **real**, no del juego: la pausa y 2×/4× no lo afectan (si no, se podía pausar para programar sin
  límite). Vive en `World` (`startPrep/vote/updatePrep`) para que el servidor del modo online lo maneje igual.
- Votos por **jugador** (`j1`, `j2`), no por robot: los robots no tienen dueño. En el prototipo local hay un botón por
  jugador en el mismo navegador; en M2 cada navegador votará por su jugador.
- Los robots sí corren durante la preparación (para probar el código y dejar los estantes llenos).
- **Solo la primera vez** (lo pidió el usuario): al abrir se guarda `prepDone` en `cdb.progress.v1`; al recargar,
  la tienda abre directo.

## El almacén es un cuarto aparte (2026-11-18)

**Pedido:** "otro cuarto, como un mini almacén, donde están guardados todos los productos"; nada sofisticado:
**apenas el robot entra al almacén puede tomar cualquier producto**. El robot carga la caja (p. ej. la leche) y la
lleva al estante.

- Cuarto de 3×6 al oeste de la tienda, con una pared bajita (para ver adentro) y una puerta arriba, en (2,5)→(3,5).
  `pick()` funciona en cualquier casilla del cuarto.
- **El almacén ES la base de datos del jugador** ("obviamente la mercancía del almacén debe ser la misma que la base
  de datos"). La web busca su tabla de inventario (la de la misión), la columna del nombre del producto y una columna
  numérica de cantidad (nombre con cant/qty/stock/unidad...). Lo que saca Toño se descuenta de esa tabla con un
  UPDATE (como el rol `jugador`), y si el jugador edita la tabla, el almacén cambia (se relee cada 2 s).
  Sin columna de cantidad, el almacén queda en 0. `WAREHOUSE_START` solo es el valor por defecto de la simulación
  (tests). Cuando un producto se acaba, `pick()` lo compra al proveedor (60% del precio), para que la partida no se
  trabe; esas compras no tocan la tabla.

## La cámara mira de frente: North = arriba (2026-11-18)

**Pedido:** "el comando move con las coordenadas está mal: North debería ir arriba". Los comandos estaban bien; la
cámara miraba en diagonal (desde el sureste) y en pantalla North se veía arriba a la izquierda. Ahora la vista por
defecto es desde el sur (North arriba, East derecha, West izquierda, South abajo) y hay una brújula con los nombres de
los comandos. **No vuelvas a poner la cámara en diagonal.**

## Información al pasar el mouse (2026-11-18)

Pedido del usuario: al pasar el mouse por un estante debe decir qué producto tiene, cuántos hay y cuántos le caben.
También funciona en las estanterías del almacén (unidades guardadas).

## Estantes libres: un solo producto, el jugador los reparte (2026-11-18)

**Pedido:** "por el momento cada estantería tendrá un solo producto; el usuario elige cómo distribuye el bot para
colocar los productos". ("Luego ya miraremos qué hacemos": puede cambiar más adelante.)

- 4 estantes que empiezan vacíos y **libres**. El primer `place()` define el producto del estante y **queda así toda
  la partida** (si se liberara al vaciarse, `estante.product()` devolvería `None` de repente y rompería los scripts).
- Se puede repetir producto (dos estantes de pan). Los clientes van al más cercano que tenga stock.

## Ventanas con marco de terminal (2026-11-19)

**Pedido:** "quítale ese color naranja o madera al borde de las ventanas, se ve feo; déjalo como una ventana de una
terminal". Las ventanas flotantes usan borde fino gris (`--term-borde`, `--term-borde-foco`), barra de título gris
carbón (`--term-barra`) y título en letra monoespaciada. La madera queda solo en las cartas de la intro y los paneles
de misión/preparación, que no son ventanas.

## Día y noche (2026-11-19)

**Pedido:** "el día dura cinco minutos y la noche diez. De día vienen los clientes (y los proveedores); de noche está
cerrado y se aprovecha para tirar código y hacer nuevas mecánicas (y encargar productos, que es otra mecánica que
vendrá). Cada vez que se reinicia el día es como otro nivel: llegan más clientes o eventos. Los 10 minutos después de
la migración de Excel a la base de datos son porque está de noche." También: "agrega más canciones dependiendo de la
situación o la hora".

- La antigua "preparación" ahora **es la noche** (`startNight/updateNight/vote`); la primera noche llega después de la
  misión. Todas las noches se pueden saltar votando los dos.
- El día cuenta **tiempo de juego** (se puede acelerar con 2×/4× para pasarlo rápido); la noche, **tiempo real** (como
  la preparación: la pausa no la alarga).
- A las 19:00 no entran más clientes, pero los de adentro terminan (no desaparecen de golpe).
- "Nivel" por ahora = +25% de clientes por día (`DAY.customerGrowth`). Eventos y proveedores: pendientes.
- Las horas de la base de datos ahora siguen el reloj del juego (de 7:00 a 19:00), así las consultas "¿a qué hora se
  vende más?" tienen sentido.
- Al recargar la simulación se reinicia (no se guarda): si ya pasó la primera noche, empieza el día 1 directo.
- Música: 5 canciones procedurales (inventario, mañana, tarde, noche, prisa). Ver `pickMusic()` en `main.ts`.

## Cada recarga empieza desde 0

**Pedido:** "cuando reinicie la página que el juego empiece desde 0". Al cargar se borran el progreso (vuelven la
intro y la primera noche), el código de los robots, las consultas guardadas y la base de datos (ahora en memoria, ya
no en IndexedDB). Se conservan el volumen y la posición/zoom de las ventanas, porque son preferencias y no partida.
Cuando exista "guardar la partida" (pendiente), esto habrá que revisarlo.

## Menú principal estilo juego grande

**Pedido:** primero "que se vea más profesional" (se probó un ticket de caja); después "está demasiado básico... que
parezca un menú de juego AAA", y arreglar que la barra del juego salía antes que el menú.
- El menú está **en `index.html`** (se ve desde el primer cuadro) y `body` empieza con `booting menu-open`: la barra,
  las ventanas y los avisos quedan ocultos hasta entrar. `start.ts` (`MainMenu`) le da vida.
- Detrás, la **tienda 3D de verdad** con la cámara meciéndose (`Store3D.showMenu()`); las etiquetas 3D se ocultan.
- Logo: barras de código que crecen, un **láser rojo de lector** que las lee y las letras que caen. Al entrar, el
  láser barre la pantalla de arriba abajo. Polvo en el aire y grano de película.
- Opciones: Entrar a la tienda (con barra de carga), Jugar en línea (bloqueada, "Pronto"), Cómo se juega, Opciones
  (volumen) y Créditos. Teclado (↑ ↓ Enter Esc), cursor que se desliza, sonidos propios (`ui-*`) y canción `portada`.

## pandas mínimo + subir con SQL (cursor.execute)

**Pedido:** primero "más sencillo, no tiene que ser 100% pandas" (se probó un pandas con comandos fáciles como
`df.clean()` y `df.save()`); después lo cambió por: "para subir los datos haya que usar el cursor.execute y la consulta
como tal de SQL", y de pandas solo **1)** leer el documento y **2)** elegir un rango tipo (A1, C3) que devuelva **una
lista de diccionarios, uno por fila**, "y ya que el mismo usuario con las funciones de Python extraiga los datos y
elimine los duplicados".
- pandas tiene **solo** `pd.read_excel(archivo)` y `hoja.select("A1", "G6")` (o `"A1:G6"`). Se quitaron DataFrame,
  Series, filtros, `to_sql`, `save`... No los vuelvas a agregar.
- Las claves de cada diccionario son los **encabezados de la fila 1**; si el rango incluye la fila 1, no se devuelve
  como dato. `print(hoja)` muestra la hoja con letras de columna y números de fila para elegir el rango.
- La conexión se llama **`cursor`** (`db` sigue como alias por compatibilidad). Acepta `%s` con los valores en una
  tupla (estilo psycopg) o `$1, $2...`.
- Limpiar (repetidos, fila TOTAL, espacios, mayúsculas) es trabajo del jugador en Python; las pistas de la misión lo
  orientan sin darle la solución.

## Botón "Saltar" en la misión de inventario

**Pedido:** "en la primera fase de la migración haya un botón que diga saltar para hacer un skip y saltar a la otra parte".
- El panel de la misión "Organiza tu inventario" tiene **Saltar ⏭** debajo de "Abrir la tienda". Pide un segundo clic
  de confirmación (4 s), sin diálogos del navegador.
- Si el jugador no tiene ya un inventario limpio, `skipMission()` (`main.ts`) crea por él la tabla `inventario` (o
  `inventario_2`...) con la hoja ya limpia y **vacía** la tabla sucia que tuviera con esos productos, para que el
  almacén lea la nueva. Es la única excepción a "la base empieza vacía": la pide el jugador al saltar.
- Después sigue igual que al completar la misión: descargan las cajas y cae la primera noche.

## Explorador de archivos (barra lateral como VS Code)

**Pedido:** "los archivos se están mostrando en el navbar, quiero un sidebar así como en Visual Studio Code... que al
darle clic abra la ventana... que se pueda minimizar".
- Barra lateral a la izquierda, debajo del letrero: una franja con el ícono de archivos (siempre visible) y el panel
  **Explorador** con el árbol `La Esquina / robots (toño.py, lupe.py) / entregas (entrega_distribuidor.xlsx) /
  inventario.py / shared.py`. Las carpetas se pliegan.
- Clic en un archivo **abre** su ventana (o la trae al frente); no la cierra. El archivo de la ventana del frente se
  resalta y los abiertos se ven más claros.
- Se minimiza con «, con el ícono o con **Ctrl+B** (como VS Code). Se recuerda en `cdb.explorer.v1`.
- En el letrero quedaron solo las herramientas: Tiquetes, Desbloqueos, Base de datos y Comandos.
- Las ventanas no pueden quedar debajo del explorador (`leftInset()` en `windows.ts`); al abrirlo se corren.
- Segunda versión ("hazlo mucho mejor, con mejor estilo"): colores de pizarra del juego con acento amarillo del
  letrero (no el gris de VS Code), íconos SVG propios (Python, hoja, carpetas), sección **Abiertos** con ×, guías de
  sangría, **estado en vivo** de cada robot e inventario.py (corriendo / pausado / error) y un contador rojo de errores
  en el ícono cuando está minimizado. Se minimiza con animación del ancho.

## Servidores, hardware y ciberseguridad

**Pedido:** que los robots funcionen con servidores locales de un cuarto de la tienda (empieza con uno), que la
capacidad del servidor defina el rendimiento de los robots, terminales Linux para conectarse por IP, una tienda en
línea para comprar componentes y **montarlos a mano en primera persona** (sin bots, nada complejo), y eventos de
ataques (DDoS...) con antivirus, logs, rastreo de la IP (nmap...) y denuncia a una "policía cibernética" con bug
bounty si la IP es la real. El rastreo **no debe ser siempre igual**: varios casos y técnicas.
- Diseño completo y fases en **`docs/servidores.md`**. Respuestas del usuario: el primer servidor se monta justo
  después de la misión del inventario (por eso la primera noche dura 20 min); los ataques por ahora solo frenan; en
  online el otro jugador sigue en la tienda; la base de datos no vive en ningún servidor.
- Fase 1 hecha: `srv-01` con 1 núcleo; un bucle sin `wait()` satura la CPU y frena a los dos robots. Las mejoras
  "CPU 2/3/4" ahora aceleran los núcleos de `srv-01`.
- "Termina todas las fases de una vez": hechas las 8. Decisiones tomadas al implementar:
  - El cuarto de servidores es un **anexo al oeste** de la tienda (fuera de la cuadrícula: los robots no caminan
    ahí). 3 puestos de rack. Clic en uno libre = montaje; clic en un servidor = su terminal.
  - Terminal **propia** (no xterm.js): ↑/↓, Tab, Ctrl+C, Ctrl+L; tuberías, `&&`, comillas y `sudo`.
  - Las herramientas de investigación **se instalan con apt** (nmap, whois, dnsutils, binutils...), para enseñar apt.
    `ufw`, `ss`, `curl`, `nc` y `ip` vienen de base.
  - Los cables del montaje vienen gratis; las piezas se compran en TecnoMercado y llegan al amanecer.
  - Las capas del rastreo son **proxies abiertos** con un panel en el puerto 8080 que dice "Último cliente
    conectado": se siguen con `whois` + `curl`. Las VPN no se pueden atravesar (hay que buscar el descuido).
  - El foro y la página de denuncias son sitios **ficticios** del navegador del juego; el foro también se puede leer
    con `curl http://foro.undernet.test/u/<apodo>`.
  - La misión del servidor tiene "Saltar" (monta `srv-01` listo y conecta a los robots).

## Sala de servidores con diseño profesional

**Pedido:** "mejora el diseño de la sala de servidores, sé más creativo y profesional... está demasiado básico y se ve feo".
- Ahora vive en `apps/web/src/serverroom.ts` (clase `ServerRoom`), en el estilo low-poly de la tienda, como un
  centro de datos pequeño: piso técnico con baldosas perforadas, franja de seguridad, pasillo frío con luz azul,
  bandeja de cables amarilla, gabinetes de 42U con puerta de malla, paneles ciegos y ventiladores en el techo, switch
  y patch panel con luces que titilan con el tráfico, UPS, extintor, consola con monitor (texto de terminal en vivo)
  y silla, letrero "SALA DE SERVIDORES" y una pantalla de monitoreo en la pared (temperatura y CPU de cada servidor).
- Todo reacciona al juego: franja de estado de cada rack (azul libre, ámbar montando o sin configurar, verde listo,
  naranja caliente, rojo parpadeante si lo atacan), luces del servidor según la carga, silueta que late en los puestos
  libres, carrito con el chasis abierto mientras se monta, aire acondicionado de precisión si lo compraron (si no, un
  ventilador de pie), y luz propia de la sala que de noche se nota más.
- Rendimiento: lo fijo se funde con `mergeStatic` (un material por color); las texturas se dibujan en canvas, sin
  archivos nuevos.

## Un solo rack al inicio (los demás se compran)

**Pedido:** "solamente debe de haber 1 solo rack ya que los racks también hay que comprarlos... se irán comprando
los otros junto con sus componentes". También: "el cable de 8 pines no aparece dónde colocarlo".
- `World.racksOwned` empieza en 1. "Gabinete de rack 42U" ($15.000) está en TecnoMercado; llega al amanecer y suma
  un puesto (máximo 3). Montar en un puesto sin rack da error; en la sala, esos puestos son una marca punteada en el
  piso y al hacer clic se abre la tienda.
- Montaje: el conector de 8 pines estaba detrás del disipador (no se veía). Ahora está arriba a la izquierda de la
  CPU; la placa dibuja sus conectores (24 y 8 pines), el SSD su conector SATA y el chasis su puerto de red. Las zonas
  donde se suelta brillan por encima de todo (`depthTest: false`).

## Proveedor en el Navegador y productos premium

**Pedido:** "agrega al navegador la página del proveedor para pedir nuevos productos... productos más costosos pero
que se venderán mucho mejor... cuando llegue el repartidor que nos pase el Excel y nosotros lo migramos; el Excel
siempre tendrá la misma estructura".
- Pestaña **El Surtidor** (`elsurtidor.test`) en el Navegador: se llama como el camión de la intro ("Distribuidora
  El Surtidor"), para que sea el mismo distribuidor. Se pide por cajas de 10; se paga al pedir; el repartidor llega
  en 1 minuto de juego (`SUPPLIER` en `config.ts`).
- El repartidor deja `pedido_N.xlsx` (carpeta **entregas** del explorador, marcado "nuevo" hasta migrarlo). Tiene
  **las mismas columnas** que `entrega_distribuidor.xlsx`, con la fila TOTAL y los mismos descuidos (nombres
  desordenados, a veces una fila repetida). La mercancía **no entra sola**: el almacén es la tabla de inventario del
  jugador, así que solo aparece cuando la migra con pandas + `cursor.execute` (`World.warehouseFromDb = true` en la
  web; en la simulación sola entra directo).
- Como el número de filas cambia entre pedidos, la hoja tiene el atributo `hoja.last_cell` ("G6") para escribir
  `hoja.select("A1", hoja.last_cell)` y reusar el script. Es un atributo, no un comando nuevo: pandas sigue teniendo
  solo `read_excel` y `select`.
- Premium: chocolate, queso, miel, aceite y vino. Más caros, con más ganancia por caja, **más demanda** (los clientes
  los piden 1,6–2,2 veces más que el pan) y cada uno en los estantes trae 12% más clientes. Los clientes solo piden lo
  premium que tiene estante (si no, habría faltantes sin culpa del jugador). El proveedor del barrio de `pick()` solo
  trae lo básico.
- Modelos 3D CC0 del mismo Food Kit de Kenney (cheese, chocolate, honey, bottle-oil, wine-red). Las estanterías
  premium van contra la pared oeste del almacén y aparecen con la primera mercancía.

## Ventana Comandos rediseñada

- El usuario dijo que se veía "horrible, letra muy pequeña e inentendible" y pidió separar los comandos por categorías.
- Ahora tiene un riel de categorías (El robot, Python, Datos, Servidores), buscador y una ficha por comando con la firma en `--fs-data` y la explicación en `--fs-ui`; el costo en ticks sale en una etiqueta. Cada grupo tiene su color.
- El id de la ventana pasó de `help` a `commands` para que no herede el tamaño angosto guardado (460 px).

## Toda la sintaxis desbloqueada; árbol de Mejoras para la tienda

- El usuario pidió que **todos los comandos y la sintaxis vengan desbloqueados** y que en su lugar haya una tienda en forma de **árbol** donde se compre: ampliar el supermercado y el centro de datos, marketing para que lleguen más clientes y más estanterías que **el mismo jugador coloca donde quiera**.
- `START_FEATURES` = todas. La ventana "Desbloqueos" ahora es "Mejoras" (`apps/web/src/upgrades.ts`), con tres ramas: La tienda, Marketing y Centro de datos (`UNLOCKS` en `config.ts`, con `branch` y `requires` como lista).
- Ampliar el local **no cambia las coordenadas**: el mapa ya trae el tamaño final y las columnas sin comprar son lotes (`1`, `2` en `KIOSCO_MAP`) que `tileAt` devuelve como `null`. Así los scripts de los jugadores siguen sirviendo.
- Los estantes comprados quedan en `world.shelvesToPlace` hasta que el jugador los pone (`world.placeShelf`). La sala de servidores empieza con espacio para 1 rack (`rackCapacity`); TecnoMercado no deja comprar más gabinetes de los que caben.

## Más cajas, cajas activas/inactivas, cliente de prueba y más robots

- El usuario pidió: (1) comprar otra caja y **elegir dónde ponerla**, que venga con su robot y el jugador le escriba el código; (2) cajas con estado **activo/inactivo** (inactiva = sin clientes); (3) de noche, **siempre un NPC de prueba** con productos en cada caja para probar el cajero, **sin descontar plata ni productos ni nada**; (4) comprar **más robots reponedores** como Toño.
- Rama nueva "Equipo" en Mejoras (`caja2`, `caja3`, `robot1`, `robot2`). Los nombres y colores están en `EXTRA_ROBOTS` (`config.ts`).
- Cada caja (`world.registers`) tiene su fila; `world.queue` es un getter con todas las filas. `REGISTER` sigue siendo la caja 1. El cajero solo atiende la fila de la caja donde está parado.
- Activar o desactivar: clic en la caja en 3D (no desde el código, por ahora).
- Clientes de prueba: `Customer.test`, ids negativos; `finishCheckout` solo emite un tiquete con `test: true` y un globo.

## Sin ticks: la velocidad sale del tamaño del código; sin CPU en Mejoras; mantenimiento de racks

- El usuario pidió **eliminar la mecánica de los ticks** y en su lugar: "entre menos código tenga un bot más rápido trabajará", cuidando las trampas con `shared.py` ("debes detectar la cantidad de líneas de las funciones importadas").
- `codesize.ts` cuenta **instrucciones** del AST (no líneas de texto) del robot + las funciones de shared que usa (transitivo) + el nivel superior de shared. Usar el módulo sin `.` (alias, pasarlo) cuenta todo shared. Factor: `1 + (n − 20) × 0,025`, entre 0,5 y 2,5. Se fija en `runRobot`. Los robots rápidos dan hasta 2–3 pasos de VM por tick.
- En la interfaz ya no aparecen ticks (Comandos, ayuda, `lscpu`). Internamente la simulación sigue avanzando en pasos de 1/10 s.
- Las mejoras **CPU 2/3/4** se quitaron del árbol (el usuario: "deja solamente el mejorar las salas"). La CPU se mejora con piezas de TecnoMercado.
- Clic en un rack con servidor: **elegir terminal o rack**. El rack abierto deja cambiar piezas (`World.openCase`, `removePart`, `disconnectCable`; `powerOn` re-enciende el mismo servidor sin perder Linux).
- Montaje rediseñado con la skill `threejs-materials-lighting`: IBL con RoomEnvironment, sombras, ACES, texturas en canvas, piezas detalladas y bandeja con tarjetas e íconos SVG.
- El panel de la noche (cuenta regresiva y votos) se movió a la barra superior; el resumen del día sale como aviso.

## Partidas en línea con Supabase (todo en tiempo real)

- El usuario eligió **Supabase** para guardar las partidas. Como el juego es privado, **todas las partidas son públicas**: cualquiera las ve en la lista y entra. Tabla `public.partidas` (`supabase/schema.sql`, se corre una vez en el SQL Editor) con RLS abierta para `anon`.
- **Nunca** se pone la clave secreta en el código (el sitio es estático: se vería). Solo va la publicable (`apps/web/src/online/supabase.ts`, o `VITE_SUPABASE_URL`/`VITE_SUPABASE_KEY`).
- "Todo debe ser en tiempo real, como Live Share": el **código** se comparte con Yjs por Supabase Realtime (broadcast), con el cursor y el nombre del otro. La **tienda**: el navegador del anfitrión (el que lleva más tiempo en la sala) corre la simulación, PostgreSQL, las terminales e `inventario.py`; el otro tiene un **mundo espejo** que recibe vistas (~7/s, solo lo que cambió). Sus acciones se aplican al tiro en el espejo y se piden al anfitrión (`online/gamesync.ts`).
- También en tiempo real: las ventanas de la historia ("Continuar", "Saltar intro", los botones de las misiones: si uno avanza, avanzan los dos), la **terminal** (compartida), los **votos** de la noche, el **montaje del rack** (si uno lo abre, al otro también; lo que monta cualquiera aparece en vivo; se ve qué tiene el otro en la mano; el encendido lo ven los dos) y los nombres de los robots.
- **Nombres de los robots**: al crear la partida los dos les ponen nombre a Toño y Lupe (lo que escribe uno le aparece al otro); al comprar un robot o una caja, también. `World.renameRobot`.
- El anfitrión guarda cada 45 s y al cambiar de día: el mundo (`encodeWorld`, con el disco de los servidores), el código (estado de Yjs) y la base del jugador con **pg_dump** de pglite-tools (unos KB; el volcado binario pesaba 4,5 MB).
- Si el anfitrión se va, el otro recarga y sigue desde el último guardado. `#partida=ABCD` en la dirección entra directo.
- Bug arreglado: el almacén salía lleno (40/30/36) antes de registrar la mercancía; ahora empieza vacío y se llena desde la tabla de inventario del jugador.

## Base y terminal en vivo, fondo fijo, consola ajustable, scan_item y depurador

- "La base de datos no es en tiempo real": `GameDB.onChange` avisa cada vez que cambian las tablas del jugador
  (sentencias que no son de lectura, `cursor.execute` de los robots, descontar del almacén, cargar o borrar). La ventana
  Base de datos refresca la lista de tablas y vuelve a correr sola la última consulta de lectura (máx. ~1 vez/s). En
  línea, el anfitrión le manda `db-changed` al otro jugador, que hace lo mismo.
- "La terminal tampoco está en tiempo real": la línea de comando es compartida; lo que escribe uno le aparece al otro
  mientras escribe (`term-typing`), no solo al dar Enter. Las contraseñas no se comparten.
- "Al mover las ventanas se mueve el fondo": la tienda se encuadraba según la posición de las ventanas de código en cada
  cuadro. Ahora ese ancho se mide una vez (al mostrar la tienda y al cambiar el tamaño del navegador); el explorador sí
  la sigue corriendo.
- La consola/variables de las ventanas de código (y la salida de inventario.py) se agrandan o achican arrastrando la
  barrita de encima (doble clic: tamaño normal). Se guarda en `cdb.panes.v1`.
- Bug "scan_item no reconoce los productos del cliente" (también con el cliente de prueba): si el código se detenía o
  se volvía a ejecutar (o se usaba el paso a paso) después de escanear, el segundo `scan_item()` devolvía `[]`. Ahora
  siempre devuelve el carrito completo. Además, al ejecutar de nuevo un robot parado en una caja, la atención del
  cliente que está ahí empieza desde cero (`World.runRobot` limpia su `checkout` si la venta no se cerró): se le puede
  volver a escanear, cobrar y dar la devuelta.
- "Con el paso a paso el juego se pausa": el depurador ya no pausa la tienda; solo se detiene ese robot.
