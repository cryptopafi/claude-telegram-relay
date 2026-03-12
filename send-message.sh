#!/bin/bash
# send-message.sh — Standalone Telegram message sender
# Usage: bash send-message.sh <chat_id> <message> [lis|automation|luna]
# Bot token sources:
#   lis        -> Keychain service: telegram-bot-token-claudemacm4 (@claudemacm4_bot)
#   automation -> Keychain service: TELEGRAM_BOT_TOKEN (legacy/claudeautomationbot)
#   luna       -> Keychain service: telegram-bot-token-luna
set -uo pipefail

CHAT_ID="${1:-}"
MESSAGE="${2:-}"
BOT_MODE="${3:-automation}"

if [ -z "$CHAT_ID" ] || [ -z "$MESSAGE" ]; then
    echo "Usage: send-message.sh <chat_id> <message> [lis|automation|luna]" >&2
    exit 1
fi

# Try .env first (automation mode only), then Keychain
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_TOKEN=""

if [ "$BOT_MODE" = "automation" ] && [ -f "$SCRIPT_DIR/.env" ]; then
    BOT_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$SCRIPT_DIR/.env" 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'")
fi

if [ -z "$BOT_TOKEN" ]; then
    case "$BOT_MODE" in
        lis)
            BOT_TOKEN=$(security find-generic-password -s "telegram-bot-token-claudemacm4" -w 2>/dev/null || echo "")
            ;;
        luna)
            BOT_TOKEN=$(security find-generic-password -s "telegram-bot-token-luna" -w 2>/dev/null || echo "")
            ;;
        automation|*)
            BOT_TOKEN=$(security find-generic-password -s "TELEGRAM_BOT_TOKEN" -w 2>/dev/null || echo "")
            ;;
    esac
fi

if [ -z "$BOT_TOKEN" ]; then
    echo "ERROR: No bot token found for mode=$BOT_MODE" >&2
    exit 1
fi

API_URL="https://api.telegram.org/bot${BOT_TOKEN}/sendMessage"

# First try Markdown, then plain text fallback (avoids formatting-related 400 errors).
HTTP_CODE=$(curl -s -o /tmp/telegram-send-response.json -w "%{http_code}" --max-time 10 \
    "$API_URL" \
    -d "chat_id=${CHAT_ID}" \
    --data-urlencode "text=${MESSAGE}" \
    -d "parse_mode=Markdown")

if [ "$HTTP_CODE" = "200" ]; then
    exit 0
fi

HTTP_CODE_FALLBACK=$(curl -s -o /tmp/telegram-send-response.json -w "%{http_code}" --max-time 10 \
    "$API_URL" \
    -d "chat_id=${CHAT_ID}" \
    --data-urlencode "text=${MESSAGE}")

if [ "$HTTP_CODE_FALLBACK" = "200" ]; then
    exit 0
fi

echo "ERROR: Telegram API returned HTTP $HTTP_CODE (Markdown), fallback HTTP $HTTP_CODE_FALLBACK" >&2
if [ -f /tmp/telegram-send-response.json ]; then
    cat /tmp/telegram-send-response.json >&2
fi
exit 1
