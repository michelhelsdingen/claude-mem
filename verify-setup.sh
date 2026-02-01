#!/bin/bash
# Claude-mem Fork Setup Verification Script

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🔍 Claude-mem Setup Verification"
echo "================================="

ERRORS=0

# 1. Check symlink
echo -n "1. Symlink check... "
if [ -L ~/.claude/plugins/marketplaces/thedotmack ]; then
    TARGET=$(readlink ~/.claude/plugins/marketplaces/thedotmack)
    if [ "$TARGET" = "/Users/michelhelsdingen/Documents/claude-mem" ] || [ "$TARGET" = "$HOME/Documents/claude-mem" ]; then
        echo -e "${GREEN}✓ Correct${NC} → $TARGET"
    else
        echo -e "${YELLOW}⚠ Points to: $TARGET${NC}"
    fi
else
    echo -e "${RED}✗ Not a symlink${NC}"
    ((ERRORS++))
fi

# 2. Check fork exists
echo -n "2. Fork source... "
if [ -d ~/Documents/claude-mem/plugin ]; then
    echo -e "${GREEN}✓ Exists${NC}"
else
    echo -e "${RED}✗ Missing${NC}"
    ((ERRORS++))
fi

# 3. Check worker script
echo -n "3. Worker script... "
if [ -f ~/Documents/claude-mem/plugin/scripts/worker-service.cjs ]; then
    echo -e "${GREEN}✓ Found${NC}"
else
    echo -e "${RED}✗ Missing${NC}"
    ((ERRORS++))
fi

# 4. Check worker running
echo -n "4. Worker status... "
HEALTH=$(curl -s http://localhost:37777/api/health 2>/dev/null)
if [ $? -eq 0 ] && echo "$HEALTH" | grep -q '"status":"ok"'; then
    VERSION=$(curl -s http://localhost:37777/api/version 2>/dev/null | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
    UPTIME=$(curl -s http://localhost:37777/api/stats 2>/dev/null | grep -o '"uptime":[0-9]*' | cut -d':' -f2)
    echo -e "${GREEN}✓ Running${NC} (v$VERSION, uptime: ${UPTIME}s)"
else
    echo -e "${RED}✗ Not running${NC}"
    ((ERRORS++))
fi

# 5. Check no conflicting cache
echo -n "5. Cache conflict... "
if [ -d ~/.claude/plugins/cache/thedotmack ]; then
    echo -e "${YELLOW}⚠ Cache exists (may cause conflicts)${NC}"
    echo "   Run: rm -rf ~/.claude/plugins/cache/thedotmack/"
else
    echo -e "${GREEN}✓ No cache conflict${NC}"
fi

# 6. Check hooks point to correct location
echo -n "6. Hooks config... "
if grep -q "marketplaces/thedotmack/plugin" ~/.claude/settings.json 2>/dev/null; then
    echo -e "${GREEN}✓ Correct${NC}"
else
    echo -e "${RED}✗ Hooks misconfigured${NC}"
    ((ERRORS++))
fi

# 7. Check database
echo -n "7. Database... "
if [ -f ~/.claude-mem/claude-mem.db ]; then
    SIZE=$(du -h ~/.claude-mem/claude-mem.db | cut -f1)
    COUNT=$(curl -s http://localhost:37777/api/stats 2>/dev/null | grep -o '"observations":[0-9]*' | cut -d':' -f2)
    echo -e "${GREEN}✓ $SIZE${NC} ($COUNT observations)"
else
    echo -e "${YELLOW}⚠ No database yet${NC}"
fi

echo "================================="
if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}✓ All checks passed!${NC}"
else
    echo -e "${RED}✗ $ERRORS error(s) found${NC}"
fi
