#!/bin/bash
# claude-mem Health Check Script
# Usage: ./scripts/health-check.sh [--json]

JSON_OUTPUT=false
[[ "${1:-}" == "--json" ]] && JSON_OUTPUT=true

WORKER_URL="http://localhost:37777"
DB_PATH="$HOME/.claude-mem/claude-mem.db"

if $JSON_OUTPUT; then
    # JSON output for programmatic use
    worker=$(curl -sf "$WORKER_URL/api/health" 2>/dev/null || echo '{"status":"down"}')
    readiness=$(curl -sf "$WORKER_URL/api/readiness" 2>/dev/null || echo '{"status":"not_ready"}')
    stats=$(curl -sf "$WORKER_URL/api/stats" 2>/dev/null || echo '{}')

    if [[ -f "$DB_PATH" ]]; then
        size=$(stat -f%z "$DB_PATH" 2>/dev/null || stat -c%s "$DB_PATH" 2>/dev/null || echo 0)
        db="{\"exists\":true,\"size\":$size}"
    else
        db='{"exists":false}'
    fi

    echo "{\"worker\":$worker,\"readiness\":$readiness,\"stats\":$stats,\"database\":$db}"
else
    # Human-readable output
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  claude-mem Health Check"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    # Worker
    if worker=$(curl -sf "$WORKER_URL/api/health" 2>/dev/null); then
        build=$(echo "$worker" | sed -n 's/.*"build":"\([^"]*\)".*/\1/p')
        echo "✅ Worker:    Running (${build:-unknown})"
    else
        echo "❌ Worker:    DOWN"
    fi

    # Readiness
    if readiness=$(curl -sf "$WORKER_URL/api/readiness" 2>/dev/null); then
        echo "✅ API:       Ready"
    else
        echo "❌ API:       Not ready"
    fi

    # Database
    if [[ -f "$DB_PATH" ]]; then
        size=$(stat -f%z "$DB_PATH" 2>/dev/null || stat -c%s "$DB_PATH" 2>/dev/null || echo 0)
        size_mb=$(awk "BEGIN {printf \"%.1f\", $size / 1048576}")
        echo "✅ Database:  ${size_mb} MB"
    else
        echo "❌ Database:  Missing"
    fi

    # Stats
    if stats=$(curl -sf "$WORKER_URL/api/stats" 2>/dev/null); then
        obs=$(echo "$stats" | sed -n 's/.*"observations":\([0-9]*\).*/\1/p')
        sessions=$(echo "$stats" | sed -n 's/.*"sessions":\([0-9]*\).*/\1/p')
        uptime=$(echo "$stats" | sed -n 's/.*"uptime":\([0-9]*\).*/\1/p')
        echo "✅ Data:      ${obs:-0} observations, ${sessions:-0} sessions"
        if [[ -n "$uptime" ]]; then
            hours=$((uptime / 3600))
            mins=$(( (uptime % 3600) / 60 ))
            echo "✅ Uptime:    ${hours}h ${mins}m"
        fi
    fi

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
fi
