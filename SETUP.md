# Claude-mem Fork Setup (MacBook)

## Architecture

```
~/Documents/claude-mem/          ← Fork source (git repo)
         ↓ symlink
~/.claude/plugins/marketplaces/thedotmack/  ← Claude Code plugin location
         ↓ hooks reference
~/.claude/settings.json          ← Hook configuration
```

## Key Paths

| Component | Path |
|-----------|------|
| Fork source | `~/Documents/claude-mem/` |
| Plugin symlink | `~/.claude/plugins/marketplaces/thedotmack` → fork |
| Worker script | `<symlink>/plugin/scripts/worker-service.cjs` |
| Database | `~/.claude-mem/claude-mem.db` |
| Logs | `~/.claude-mem/logs/` |
| Settings | `~/.claude-mem/settings.json` |

## Update Workflow

```bash
# 1. Pull updates to fork
cd ~/Documents/claude-mem
git pull

# 2. Build (if needed)
bun install && bun run build

# 3. Restart worker
pkill -f "worker-service"
# Worker auto-starts via hooks on next Claude Code session
```

## Verify Setup

```bash
# Check symlink
ls -la ~/.claude/plugins/marketplaces/thedotmack

# Check worker status
curl -s http://localhost:37777/api/readiness

# Check version
curl -s http://localhost:37777/api/version

# Check for restart loops (should be empty after startup)
tail -50 ~/.claude-mem/logs/claude-mem-$(date +%Y-%m-%d).log | grep -c "Shutdown initiated"
```

## Troubleshooting

### Worker keeps restarting
Check that only ONE plugin location is active. Remove cache versions:
```bash
rm -rf ~/.claude/plugins/cache/thedotmack/
```

### Symlink broken
```bash
ln -sf ~/Documents/claude-mem ~/.claude/plugins/marketplaces/thedotmack
```

### Worker not starting
```bash
cd ~/.claude/plugins/marketplaces/thedotmack/plugin
bun scripts/worker-service.cjs --daemon
```
