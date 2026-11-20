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
