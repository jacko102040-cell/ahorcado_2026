# Ahorcado Multiplayer

Juego web de ahorcado en tiempo real con ingreso rapido (solo nombre), salas por codigo, turnos, equipos, votos y panel admin para banco de palabras.

## Stack
- Next.js (frontend + API routes)
- Supabase (Postgres + Auth anonimo + Realtime)
- Vercel (deploy gratis para uso personal)

## Funciones incluidas
- Salas dinamicas por codigo (`OFICINA`, `TEAM-A`, etc).
- Turnos reales por jugador con temporizador.
- Categoria y dificultad al iniciar ronda.
- Pista opcional con penalizacion de puntaje.
- Votacion para revancha y reset de puntajes.
- Modo equipos A vs B.
- Limpieza de desconectados + reasignacion de host/turno.
- Panel admin `/admin` para CRUD de palabras.

## 1) Configurar Supabase
1. Crea un proyecto nuevo en Supabase.
2. En `Authentication -> Providers -> Anonymous`, habilita `Allow anonymous sign-ins`.
3. Abre SQL Editor y ejecuta `supabase/schema.sql`.
4. En `Database -> Replication`, habilita Realtime para tablas:
   - `players`
   - `rounds`
   - `rooms`
   - `room_votes`
5. Copia:
   - `Project URL`
   - `anon public key`
   - `service_role key`

## 2) Variables de entorno
1. Duplica `.env.example` como `.env.local`.
2. Completa:

```bash
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
ADMIN_PANEL_TOKEN=...
```

## 3) Ejecutar local
```bash
npm install
npm run dev
```

App de juego: `http://localhost:3000`  
Panel admin: `http://localhost:3000/admin`

## 4) Deploy en Vercel
1. Sube este proyecto a GitHub.
2. Importa el repo en Vercel.
3. En `Environment Variables`, agrega las 4 variables del `.env.example`.
4. Deploy.

## Consideracion de version de esquema
`supabase/schema.sql` incluye un bloque de reset (`drop table if exists ...`) pensado para ambiente nuevo o DB reset.
"# ahorcado_2026" 
# ahorcado_2026
