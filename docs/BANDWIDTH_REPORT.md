# Bandwidth Report — prueba real ~120 kbps

**Fecha:** 2026-08-25 · **Fase 9 del roadmap**

## Topología de la prueba

| Rol | Dispositivo / navegador | Resultado |
| --- | --- | --- |
| Participante A | Laptop (Chrome) | ✅ completo |
| Participante B | iPad (Safari) | ✅ completo |
| Participante C | Teléfono Android (Chrome) | ⚠️ micrófono no funcionó |

Enlace limitado a **~120 kbps** (15 kB/s) durante la sesión.

## Números observados (tarjeta NETWORK, lado A)

> Una sola sesión; duración no registrada. Los totales corresponden al
> tráfico WebSocket (board + avatar + control); **no incluyen** el audio P2P
> (WebRTC viaja directo entre pares, sin pasar por el servidor) ni la
> descarga única del modelo facial (~3.7 MB desde CDN, cacheada después).

| Métrica | Valor |
| --- | --- |
| Tráfico total de la sesión | **1025.9 KB** |
| Rate pico | **15.2 kB/s** (≈ el tope del enlace: saturación puntual) |
| Total enviado | **653 KB** |
| Total recibido | **398 KB** |
| Pizarra funcional | sí, sin trazos perdidos reportados |

### Lectura de los números

- El pico coincide exactamente con el ancho de banda disponible: hubo un
  momento de saturación (esperable durante ráfagas de dibujo + presencia).
  La cola de salida (`outbox`) absorbe esos picos sin perder ops.
- Enviado > recibido es consistente con que A fue quien dibujó y transmitió
  pose de avatar; los receptores solo reciben deltas.
- Con audio activo, sumar ~12–16 kbps P2P (ver `BANDWIDTH_AUDIO.md`) sigue
  dejando holgura dentro de los 120 kbps porque no comparte el canal WS.
- Presupuesto teórico vs real: ver `BANDWIDTH_AVATAR.md`
  (idle ≈ 37 B/s, hablando ≈ 127 B/s por avatar).

## Incidencia abierta

### Micrófono en Android Chrome (participante C)

- **Síntoma:** el botón de voz no produjo transmisión audible.
- **Mitigaciones aplicadas tras la prueba** (commit actual):
  - reanudación de `<audio>` remotos en el primer gesto táctil/click
    (Android bloquea autoplay sin gesto);
  - atributo `playsinline` en elementos remotos;
  - logging detallado de `connectionState`/ICE para diagnóstico remoto.
- **Pendiente:** repetir la prueba con el teléfono y capturar consola
  remota (`chrome://inspect`) si persiste.

## Veredicto

El concepto se sostiene a ~120 kbps: pizarra colaborativa fluida, avatares
animados y voz simultáneos, con saturaciones absorbidas por cola y
supresión de pose. Fase 9 marcada ✅ con la incidencia de audio Android
como único pendiente de re-verificación.
