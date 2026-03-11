# Ahorcado Multiplayer - Especificacion Actual

## 1) Objetivo
- Juego web rapido para oficina (uso personal), sin passwords.
- Entrada solo con nombre + codigo de sala.
- Soportar partidas dinamicas para ~6 personas.

## 2) Funcionalidad implementada
- Salas por codigo (`OFICINA`, `TEAM-A`, etc).
- Login anonimo Supabase (`signInAnonymously`) + nombre visible.
- Rondas por turnos con temporizador por jugador.
- Categoria y dificultad al iniciar ronda.
- Pista opcional con penalizacion de puntaje.
- Votacion para:
  - revancha (inicia ronda cuando alcanza quorum)
  - reset de puntajes
- Modo equipos A vs B.
- Reconexion y limpieza de inactivos con `heartbeat` + rotacion de host/turno.
- Panel admin `/admin` para CRUD del banco de palabras.

## 3) Arquitectura
- Frontend: Next.js + TypeScript.
- Backend: Supabase Postgres + Realtime + Auth anonimo.
- Seguridad:
  - RLS habilitada.
  - Cliente solo consulta tablas permitidas.
  - Mutaciones via RPC (`security definer`).
  - Palabra secreta en `round_secrets` (no expuesta al cliente).
  - Admin CRUD por API server-side con `SUPABASE_SERVICE_ROLE_KEY` + `ADMIN_PANEL_TOKEN`.

## 4) Modelo de datos
- `rooms`: configuracion de sala, modo equipos, timer, errores maximos.
- `players`: jugadores activos, host, orden de turno, equipo y score.
- `rounds`: estado visible de la ronda y turno actual.
- `round_secrets`: palabra/hint real de la ronda.
- `guesses`: historial de letras.
- `room_votes`: votos de revancha/reset.
- `words`: banco de palabras (categoria, dificultad, hint, activa/inactiva).

## 5) RPC principales
- `join_room(room_code, display_name, requested_team?)`
- `set_team_mode(room_code, enabled)`
- `start_round(room_code, category?, difficulty?)`
- `guess_letter(room_code, letter)`
- `advance_turn(room_code, force?)`
- `use_hint(room_code)`
- `vote_rematch(room_code)`
- `vote_reset_scores(room_code)`
- `get_vote_status(room_code)`
- `heartbeat(room_code)`
- `leave_room(room_code)`

## 6) Deploy
1. Ejecutar `supabase/schema.sql` en proyecto nuevo o DB reset.
2. Activar `Anonymous sign-ins`.
3. Activar Realtime en: `players`, `rounds`, `rooms`, `room_votes`.
4. Configurar env vars:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `ADMIN_PANEL_TOKEN`
5. Deploy en Vercel (Hobby valido para uso personal).

## 7) Consideraciones actuales
- `schema.sql` contiene reset (`drop table if exists`) para facilitar reinicio en esta etapa.
- El panel admin depende de secretos server-side; no exponer `SUPABASE_SERVICE_ROLE_KEY` al cliente.
