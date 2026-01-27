# Claude-Mem Stability & Architecture Plan

**Datum**: 27 januari 2026
**Status**: Ontwerp goedgekeurd, nog niet uitgevoerd
**Baseline**: claude-mem v9.0.10 (thedotmack/claude-mem)

---

## 1. Overview & Goals

### Probleem

Claude-mem v9.0.10 draait als marketplace plugin maar is chronisch instabiel:

- **Process leaks**: Chroma-MCP en Claude subprocesses lekken als orphans (13GB+ / 50GB+ geheugen, issues #803, #789)
- **Chroma crashes**: chroma-mcp crasht regelmatig, vereist externe monitoring en auto-restart
- **Orphaned MCP servers**: `mcp-server.cjs` processen blijven hangen na sessie-einde (ppid=1)
- **Pleisters**: 3 LaunchAgents + een 400-regel cleanup script nodig om het systeem draaiende te houden
- **Geen eigen patches mogelijk**: marketplace plugin kan niet aangepast worden

### Doel

Een eigen lokale fork van claude-mem die:

1. **Altijd werkt** - Claude Code en Happy sessies starten betrouwbaar met werkend geheugen
2. **Zelf aanpasbaar** - Stabiliteitsfixes en architectuurwijzigingen in eigen beheer
3. **Updatable** - Upstream changes van thedotmack binnenhalen via `git fetch upstream`
4. **Auto-deployt** - Na een pull/commit automatisch builden en worker herstarten
5. **Database intact** - `~/.claude-mem/` wordt nooit aangeraakt door migratie of deploys

### Scope

| Fase | Focus | Doel |
|------|-------|------|
| **Fase 0** | Fork + pipeline | Werkende lokale fork met auto-deploy |
| **Fase 1** | Stabiliteit | Process leaks fixen, cleanup scripts overbodig maken |
| **Fase 2** | Architectuur | HTTP/SSE transport, eliminatie stdio MCP processen |

### Wat niet verandert

- Database locatie (`~/.claude-mem/claude-mem.db`)
- Settings (`~/.claude-mem/settings.json`)
- Backup LaunchAgent (`com.claude-mem.backup.plist`)
- Worker poort (37777)
- Tool schemas (search, timeline, get_observations)

---

## 2. Repository & Fork Setup

### Directory structuur

```
~/Documents/claude-mem/                  <-- source-of-truth (lokale fork)
├── src/                                 <-- TypeScript source (upstream + eigen patches)
├── plugin/                              <-- built output
├── scripts/
│   ├── deploy.sh                        <-- build + sync + restart
│   └── update.sh                        <-- upstream pull + deploy
├── package.json                         <-- v9.0.10 basis
└── .git/
    └── config
        └── remotes:
            └── upstream → https://github.com/thedotmack/claude-mem.git
```

Geen remote `origin` — alleen lokaal. Upstream remote voor het binnenhalen van updates.

### Initialisatie stappen

```bash
# 1. Kopieer werkende source
cp -r ~/.claude/plugins/marketplaces/thedotmack/ ~/Documents/claude-mem/

# 2. Schone git init
cd ~/Documents/claude-mem
rm -rf .git
git init
git add -A
git commit -m "baseline: claude-mem v9.0.10 (fork from thedotmack)"

# 3. Upstream remote
git remote add upstream https://github.com/thedotmack/claude-mem.git
git fetch upstream
```

### Upstream sync workflow

```bash
git fetch upstream main
git merge upstream/main          # of: git cherry-pick specifieke commits
# Bij conflicten: eigen patches winnen, handmatig resolven
```

### Plugin referentie

`~/.claude.json` wordt aangepast zodat de plugin naar de fork wijst:
- Plugin pad: `~/Documents/claude-mem/plugin/`
- De `plugins/cache/` wordt gevuld door `deploy.sh`

---

## 3. Build & Deploy Pipeline

### Happy-integratie

Happy (web/telefoon) en lokale Claude Code CLI laden claude-mem als plugin uit dezelfde cache:
`~/.claude/plugins/cache/thedotmack/claude-mem/9.0.10/`

Dit pad moet na elke deploy werkende, gebuilde code bevatten.

### Deploy script (`scripts/deploy.sh`)

```bash
#!/bin/bash
set -euo pipefail

REPO_DIR="$HOME/Documents/claude-mem"
CACHE_DIR="$HOME/.claude/plugins/cache/thedotmack/claude-mem/9.0.10"
ROLLBACK_DIR="/tmp/claude-mem-rollback"
LOG="$HOME/.claude-mem/logs/deploy.log"
WORKER_PORT=37777

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# 1. Pre-flight
log "=== DEPLOY START ==="
command -v bun >/dev/null || { log "ERROR: bun not found"; exit 1; }

# 2. Build
log "Building source..."
cd "$REPO_DIR"
bun run build || { log "ERROR: Build failed, aborting"; exit 1; }

# 3. Backup huidige cache
log "Backing up current cache..."
rm -rf "$ROLLBACK_DIR"
cp -r "$CACHE_DIR" "$ROLLBACK_DIR"

# 4. Sync naar cache
log "Syncing to plugin cache..."
rsync -a --delete "$REPO_DIR/plugin/" "$CACHE_DIR/"

# 5. Graceful worker shutdown
log "Stopping worker..."
curl -sf -X POST "http://127.0.0.1:$WORKER_PORT/api/admin/shutdown" -m 5 2>/dev/null || true
sleep 2

# Fallback: force kill als worker nog draait
if lsof -ti:$WORKER_PORT >/dev/null 2>&1; then
    log "Force killing worker on port $WORKER_PORT"
    kill -9 $(lsof -ti:$WORKER_PORT) 2>/dev/null || true
    sleep 1
fi

# 6. Wait for port free
for i in $(seq 1 10); do
    lsof -ti:$WORKER_PORT >/dev/null 2>&1 || break
    log "Waiting for port $WORKER_PORT to free... ($i/10)"
    sleep 1
done

# 7. Start worker daemon
log "Starting worker daemon..."
bun "$CACHE_DIR/scripts/worker-service.cjs" --daemon &
disown

# 8. Health check
log "Waiting for health..."
for i in $(seq 1 15); do
    if curl -sf "http://127.0.0.1:$WORKER_PORT/api/health" -m 2 >/dev/null 2>&1; then
        READINESS=$(curl -sf "http://127.0.0.1:$WORKER_PORT/api/readiness" -m 2 2>/dev/null)
        log "Worker healthy: $READINESS"
        log "=== DEPLOY SUCCESS ==="
        exit 0
    fi
    sleep 2
done

# 9. Rollback bij falen
log "ERROR: Worker failed to start, rolling back..."
kill -9 $(lsof -ti:$WORKER_PORT) 2>/dev/null || true
cp -r "$ROLLBACK_DIR/" "$CACHE_DIR/"
bun "$CACHE_DIR/scripts/worker-service.cjs" --daemon &
disown
log "=== DEPLOY FAILED - ROLLED BACK ==="
exit 1
```

### Update script (`scripts/update.sh`)

```bash
#!/bin/bash
set -euo pipefail

REPO_DIR="$HOME/Documents/claude-mem"
LOG="$HOME/.claude-mem/logs/deploy.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

cd "$REPO_DIR"

# 1. Stash eigen uncommitted werk
log "=== UPDATE START ==="
git stash --include-untracked 2>/dev/null || true

# 2. Fetch + merge upstream
log "Fetching upstream..."
git fetch upstream main

log "Merging upstream/main..."
if ! git merge upstream/main --no-edit; then
    log "ERROR: Merge conflict, aborting"
    git merge --abort
    git stash pop 2>/dev/null || true
    exit 1
fi

# 3. Herstel eigen werk
git stash pop 2>/dev/null || true

# 4. Deploy
log "Merge successful, deploying..."
exec "$REPO_DIR/scripts/deploy.sh"
```

### Auto-deploy LaunchAgent (`com.claude-mem.auto-deploy.plist`)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude-mem.auto-deploy</string>
    <key>WatchPaths</key>
    <array>
        <string>/Users/michelhelsdingen/Documents/claude-mem/.git/refs/heads/main</string>
    </array>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/Users/michelhelsdingen/Documents/claude-mem/scripts/deploy.sh</string>
    </array>
    <key>StandardOutPath</key>
    <string>/Users/michelhelsdingen/.claude-mem/logs/auto-deploy-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/michelhelsdingen/.claude-mem/logs/auto-deploy-stderr.log</string>
</dict>
</plist>
```

### Handmatig gebruik

```bash
~/Documents/claude-mem/scripts/update.sh    # upstream pull + auto deploy
~/Documents/claude-mem/scripts/deploy.sh    # alleen build + deploy (na eigen wijzigingen)
```

---

## 4. Stabiliteit (Fase 1)

### Relevante GitHub Issues

| Issue | Beschrijving | Ernst |
|-------|-------------|-------|
| #803 | Worker spawnt ongelimiteerd Claude subprocesses (13GB+) | Kritiek |
| #789 | Worker accumuleert state, 50GB+ geheugen | Kritiek |
| #761 | Chroma zombies, verzoek om disable optie | Hoog |
| #752 | HTTP/SSE transport voor multi-instance | Architectuur |
| #740 | Orphaned 'active' sessions blokkeren queue | Medium |
| #730 | Vector-db groeit naar 1TB+ | Hoog |
| #725 | Worker host setting genegeerd bij IPv6 | Medium |

### 4.1 Chroma-MCP process leaks (grootste probleem)

**Root cause**: Elke ChromaSync instantie spawnt een `uvx chroma-mcp` subprocess via `StdioClientTransport`. Als de worker crasht of `close()` niet wordt aangeroepen, blijven chroma processes als orphans draaien. Dit stapelt op tot 13GB+.

**Fixes**:

1. **`CLAUDE_MEM_DISABLE_VECTOR_SEARCH` setting** (makkelijkste win)
   - Nieuwe setting in `settings.json` om Chroma helemaal uit te schakelen
   - SQLite FTS5 blijft werken voor keyword search
   - Elimineert de grootste bron van instabiliteit
   - Bestand: `src/services/sync/ChromaSync.ts` — early return als disabled

2. **Process group management**
   - Worker start chroma met `detached: false` zodat OS automatisch opruimt bij worker exit
   - Bestand: `src/services/sync/ChromaSync.ts` lijn ~132

3. **PID tracking**
   - Worker schrijft child PIDs naar `~/.claude-mem/worker-children.pid`
   - Shutdown leest en killt deze PIDs
   - Bestand: `src/services/infrastructure/ProcessManager.ts`

4. **Watchdog in worker**
   - Als chroma niet reageert binnen 30s: kill + herstart (intern, niet extern script)
   - Bestand: `src/services/worker-service.ts`

### 4.2 Claude subprocess memory leak (#803, #789)

**Root cause**: De worker spawnt Claude SDK Agent subprocesses (`SDKAgent.ts`) voor AI-processing van observaties. Deze worden niet opgeruimd na gebruik.

**Fixes**:

1. **Worker pool limiet**
   - Maximum aantal gelijktijdige Claude subprocesses (bijv. 2)
   - Queue voor overflow in plaats van ongelimiteerd spawnen
   - Bestand: `src/services/worker/SDKAgent.ts`

2. **Process lifecycle**
   - Subprocess afsluiten na elke observatie-verwerking
   - Of: hergebruiken met idle timeout (kill na 60s inactiviteit)

3. **Periodieke worker restart**
   - Optioneel: worker herstart zichzelf elke N uur om state-accumulation te voorkomen
   - Graceful: wacht tot queue leeg is, dan restart

### 4.3 Orphaned MCP server processes

**Root cause**: Elke Claude Code / Happy sessie start een `mcp-server.cjs` via stdio. Bij abrupt sessie-einde (crash, stroomuitval) blijft het MCP process hangen met `ppid=1`.

**Fixes**:

1. **Parent heartbeat**
   - MCP server checkt `process.ppid` elke 30s
   - Exit als parent process weg is (ppid=1 op Unix)
   - Bestand: `src/servers/mcp-server.ts`

2. **Startup guard**
   - Worker checkt bij start hoeveel mcp-server processes actief zijn
   - Killt stale ones (ppid=1, ouder dan 5 min)
   - Bestand: `src/services/infrastructure/ProcessManager.ts`

### 4.4 Session queue recovery (#740)

**Root cause**: Sessions die 'active' blijven na crash blokkeren de verwerkingsqueue.

**Fix**:
- Bij worker start: markeer sessions ouder dan 10 min als 'failed'
- Bestand: `src/services/worker/SessionManager.ts` (of equivalent)

### 4.5 Na fase 1: opruiming

**Verwijderen**:
- `~/.claude/cleanup-claude-mem.sh` (400-regel script)
- `com.claude-mem.orphan-reaper.plist` (5-min cleanup LaunchAgent)
- `com.claude-mem.cleanup.plist` (5-min MCP cleanup LaunchAgent)

**Behouden**:
- `com.claude-mem.backup.plist` (dagelijkse database backup om 03:00)
- `com.claude-mem.auto-deploy.plist` (nieuw, voor deploy pipeline)

---

## 5. Architectuur (Fase 2) — HTTP/SSE Transport

### Huidige architectuur (probleem)

```
Claude Code sessie 1  ──stdio──>  mcp-server.cjs (process 1)  ──HTTP──>  worker:37777
Claude Code sessie 2  ──stdio──>  mcp-server.cjs (process 2)  ──HTTP──>  worker:37777
Happy sessie          ──stdio──>  mcp-server.cjs (process 3)  ──HTTP──>  worker:37777
```

Elke sessie spawnt een apart `mcp-server.cjs` Node process via stdio. Die processen lekken als orphans bij abrupte sessie-einden. De MCP server is al een thin HTTP wrapper — het doet alleen protocol vertaling van MCP stdio naar HTTP calls naar de worker.

### Nieuwe architectuur (oplossing)

```
Claude Code sessie 1  ──HTTP/SSE──>  worker:37777 (ingebouwde MCP endpoint)
Claude Code sessie 2  ──HTTP/SSE──>  worker:37777
Happy sessie          ──HTTP/SSE──>  worker:37777
```

### Wat verandert

- MCP server wordt ingebouwd in de worker (Express endpoint `/mcp` op port 37777)
- Gebruikt `SSEServerTransport` of `StreamableHTTPServerTransport` uit `@modelcontextprotocol/sdk`
- Geen losse mcp-server.cjs processen meer — nul orphan risico
- `.mcp.json` wijzigt van `stdio` naar `url: http://127.0.0.1:37777/mcp`

### Wat niet verandert

- Worker API endpoints (search, timeline, observations) — blijven identiek
- Database, settings, poort — alles hetzelfde
- Tool schemas (search, timeline, get_observations) — zelfde interface

### Plugin config wijziging

`.mcp.json` (oud):
```json
{
  "mcpServers": {
    "mcp-search": {
      "type": "stdio",
      "command": "${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.cjs"
    }
  }
}
```

`.mcp.json` (nieuw):
```json
{
  "mcpServers": {
    "mcp-search": {
      "type": "sse",
      "url": "http://127.0.0.1:37777/mcp"
    }
  }
}
```

### Risico's en fallback

- **Risico**: Claude Code moet SSE/HTTP MCP transport ondersteunen. Dit is standaard in de MCP spec maar moet getest worden met de huidige Claude Code versie en Happy.
- **Fallback**: Als SSE niet werkt, behoud stdio maar met de heartbeat-fix uit fase 1. De architectuurwinst is dan kleiner maar stabiliteit is al opgelost.

---

## 6. Migratie & Rollback

### Migratieplan (van marketplace plugin naar lokale fork)

#### Stap 1: Backup

```bash
# Marketplace plugin backup
cp -r ~/.claude/plugins/marketplaces/thedotmack/ /tmp/claude-mem-marketplace-backup/

# Database backup
cp ~/.claude-mem/claude-mem.db ~/.claude-mem/claude-mem.db.pre-migration
```

#### Stap 2: Fork repo opzetten

```bash
# Kopieer source
cp -r ~/.claude/plugins/marketplaces/thedotmack/ ~/Documents/claude-mem/

# Verse git init
cd ~/Documents/claude-mem
rm -rf .git
git init
git add -A
git commit -m "baseline: claude-mem v9.0.10 (fork from thedotmack)"

# Upstream remote
git remote add upstream https://github.com/thedotmack/claude-mem.git
git fetch upstream
```

#### Stap 3: Scripts aanmaken

```bash
mkdir -p ~/Documents/claude-mem/scripts
# deploy.sh en update.sh schrijven (zie sectie 3)
chmod +x ~/Documents/claude-mem/scripts/*.sh
```

#### Stap 4: Plugin referentie wijzigen

- `~/.claude.json` aanpassen: plugin pad wijzen naar `~/Documents/claude-mem/plugin/`
- Eerste `deploy.sh` run: sync naar cache
- Test: nieuwe Claude Code sessie starten, check of memory werkt

#### Stap 5: Auto-deploy LaunchAgent installeren

```bash
cp com.claude-mem.auto-deploy.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.claude-mem.auto-deploy.plist
```

#### Stap 6: Oude infra opruimen (na fase 1 fixes)

```bash
# Oude cleanup LaunchAgents uitschakelen
launchctl unload ~/Library/LaunchAgents/com.claude-mem.orphan-reaper.plist
launchctl unload ~/Library/LaunchAgents/com.claude-mem.cleanup.plist

# Cleanup script verwijderen
rm ~/.claude/cleanup-claude-mem.sh

# Marketplace plugin directory verwijderen (backup bewaard in /tmp/)
rm -rf ~/.claude/plugins/marketplaces/thedotmack
```

### Rollback procedure

Als de fork niet werkt:

```bash
# 1. Worker stoppen
curl -sf -X POST http://127.0.0.1:37777/api/admin/shutdown -m 5 || true
sleep 2
kill -9 $(lsof -ti:37777) 2>/dev/null || true

# 2. Cache herstellen
cp -r /tmp/claude-mem-marketplace-backup/plugin/ \
      ~/.claude/plugins/cache/thedotmack/claude-mem/9.0.10/

# 3. ~/.claude.json terugzetten (als gewijzigd)

# 4. Worker starten
bun ~/.claude/plugins/cache/thedotmack/claude-mem/9.0.10/scripts/worker-service.cjs --daemon &
```

Database (`~/.claude-mem/`) wordt nooit aangeraakt. Maximale downtime: ~30 seconden.

---

## Implementatievolgorde

### Fase 0: Fork + Pipeline (eerst)
1. [ ] Backup huidige staat
2. [ ] Fork repo opzetten in `~/Documents/claude-mem/`
3. [ ] `deploy.sh` en `update.sh` schrijven en testen
4. [ ] Plugin referentie wijzigen in `~/.claude.json`
5. [ ] Eerste deploy testen (Claude Code + Happy)
6. [ ] Auto-deploy LaunchAgent installeren

### Fase 1: Stabiliteit
7. [ ] `CLAUDE_MEM_DISABLE_VECTOR_SEARCH` setting toevoegen
8. [ ] Chroma process group management (detached: false)
9. [ ] PID tracking voor child processes
10. [ ] Claude subprocess pool limiet (max 2)
11. [ ] MCP server parent heartbeat (ppid check)
12. [ ] Session queue recovery (stale session cleanup)
13. [ ] Interne watchdog voor chroma health
14. [ ] Oude cleanup scripts en LaunchAgents verwijderen
15. [ ] Testen: 24 uur draaien zonder handmatige interventie

### Fase 2: Architectuur
16. [ ] SSE/HTTP transport testen met Claude Code
17. [ ] MCP endpoint inbouwen in worker (`/mcp`)
18. [ ] `.mcp.json` wijzigen naar SSE type
19. [ ] Testen met Happy
20. [ ] `mcp-server.cjs` verwijderen als SSE werkt
21. [ ] Fallback: stdio behouden met heartbeat als SSE niet werkt
