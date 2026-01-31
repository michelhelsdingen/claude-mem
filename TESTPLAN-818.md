# Testplan Issue #818: Hanging Haiku Processes

## Overzicht van de Fixes

### Wat is gewijzigd:
1. **Age-based process killing** - Processen >5 min worden automatisch gekilld
2. **SDK watchdog timeout** - 3 min voor eerste response, 2 min idle timeout
3. **Agressieve pool cleanup** - Killt processen >2 min wanneer pool vol is
4. **Snellere reaper** - Elke 60 sec i.p.v. 5 min

## Pre-Test Setup

```bash
# 1. Rebuild en sync naar plugin folder
cd ~/Documents/claude-mem
npm run build-and-sync

# 2. Check dat worker niet draait
curl http://localhost:37777/api/health || echo "Worker not running (expected)"

# 3. Kill eventuele zombie processen
pkill -f "claude.*haiku" 2>/dev/null || true
```

## Test 1: Normale Werking (Smoke Test)

**Doel:** Verifieer dat normale operaties nog werken

```bash
# Start een Claude Code sessie in een project
cd ~/Documents/some-project
claude

# Doe een simpele actie (file lezen, vraag stellen)
# Verwacht: claude-mem moet observaties opslaan
```

**Check:**
```bash
# Bekijk worker logs
tail -f ~/.claude-mem/logs/worker.log | grep -E "(SDK|PROCESS|SESSION)"

# Check database voor nieuwe observations
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations WHERE created_at_epoch > strftime('%s','now')*1000 - 300000;"
```

## Test 2: Pool Exhaustion Recovery

**Doel:** Verifieer dat pool cleanup werkt bij vol

```bash
# 1. Set pool limit laag (tijdelijk)
# Edit ~/.claude-mem/settings.json:
# "CLAUDE_MEM_MAX_CONCURRENT_AGENTS": "2"

# 2. Open 3+ Claude Code terminals tegelijk
# Terminal 1: cd ~/project1 && claude
# Terminal 2: cd ~/project2 && claude
# Terminal 3: cd ~/project3 && claude

# 3. Doe in alle terminals tegelijk een actie
```

**Verwacht gedrag:**
- Log moet tonen: "Pool limit reached...attempting cleanup"
- Oude processen worden gekilld
- Nieuwe sessies starten succesvol

**Check logs:**
```bash
grep -E "Pool limit|Force-cleaned|pool_full_cleanup" ~/.claude-mem/logs/worker.log
```

## Test 3: SDK Timeout (Simulated Hang)

**Doel:** Verifieer dat watchdog timeout werkt

```bash
# Dit is moeilijk te simuleren zonder code changes
# Alternatief: monitor logs tijdens normaal gebruik

# Kijk voor timeout warnings:
tail -f ~/.claude-mem/logs/worker.log | grep -E "timeout|Session timeout|exceeded_max_age"
```

**Na 3+ minuten zonder SDK response moet je zien:**
- "Session timeout: no message for Xs"
- Session wordt geabort
- Proces wordt gekilld door reaper

## Test 4: Age-based Reaper

**Doel:** Verifieer dat oude processen worden gekilld

```bash
# 1. Start een sessie
# 2. Wacht 5+ minuten zonder activiteit
# 3. Check of reaper het process killt

grep "exceeded_max_age\|Killing stale PID" ~/.claude-mem/logs/worker.log
```

## Test 5: Stress Test

**Doel:** Verifieer stabiliteit onder load

```bash
# Open meerdere terminals en voer tegelijk uit:
for i in {1..5}; do
  (cd ~/Documents/project$i && claude -p "list files" &)
done

# Monitor:
watch -n 1 'ps aux | grep -c "claude.*haiku"'
watch -n 1 'curl -s http://localhost:37777/api/status | jq .activeSessions'
```

## Monitoring Commands

```bash
# Live process count
watch -n 2 'ps aux | grep -E "claude.*(haiku|output-format)" | grep -v grep | wc -l'

# Worker status
curl -s http://localhost:37777/api/status | jq

# Database session status
sqlite3 ~/.claude-mem/claude-mem.db "SELECT status, COUNT(*) FROM sdk_sessions GROUP BY status;"

# Recent errors
grep -i error ~/.claude-mem/logs/worker.log | tail -20
```

## Rollback Plan

Als er problemen zijn:

```bash
# 1. Stop worker
curl -X POST http://localhost:37777/api/shutdown

# 2. Kill alle claude processen
pkill -9 -f "claude.*haiku"

# 3. Revert naar vorige versie
cd ~/Documents/claude-mem
git checkout HEAD~1 -- src/services/worker/ProcessRegistry.ts src/services/worker/SDKAgent.ts
npm run build-and-sync
```

## Success Criteria

- [ ] Normale Claude Code sessies werken nog
- [ ] Observations worden opgeslagen in database
- [ ] Pool vol situatie herstelt automatisch binnen 15 sec
- [ ] Geen zombie processen na 5+ minuten
- [ ] Logs tonen geen "Agent pool timeout" errors na fix
- [ ] Memory gebruik blijft stabiel (<1GB voor worker)

## Known Issues to Watch

1. **Rate limiting** - Anthropic rate limits kunnen timeouts veroorzaken (dit is verwacht gedrag)
2. **Network issues** - Kan ook timeouts veroorzaken (verwacht gedrag)
3. **Large contexts** - Haiku heeft kleinere context, kan falen bij grote prompts
