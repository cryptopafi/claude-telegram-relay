#!/bin/bash
# send-message.sh — Standalone Telegram message sender for NexusOS SENTINEL
# Usage: bash send-message.sh <chat_id> <message>
# Retrieves bot token from macOS Keychain (TELEGRAM_BOT_TOKEN)
set -uo pipefail

CHAT_ID="${1:-}"
MESSAGE="${2:-}"

if [ -z "$CHAT_ID" ] || [ -z "$MESSAGE" ]; then
    echo "Usage: send-message.sh <chat_id> <message>" >&2
    exit 1
fi

# Try .env first, then Keychain
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_TOKEN=""

if [ -f "$SCRIPT_DIR/.env" ]; then
    BOT_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$SCRIPT_DIR/.env" 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'")
fi

if [ -z "$BOT_TOKEN" ]; then
    BOT_TOKEN=$(security find-generic-password -s "TELEGRAM_BOT_TOKEN" -w 2>/dev/null || echo "")
fi

if [ -z "$BOT_TOKEN" ]; then
    echo "ERROR: No bot token found in .env or Keychain" >&2
    exit 1
fi

# Send via Telegram API
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
    "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    --data-urlencode "text=${MESSAGE}" \
    -d "parse_mode=Markdown")

if [ "$HTTP_CODE" = "200" ]; then
    exit 0
else
    echo "ERROR: Telegram API returned HTTP $HTTP_CODE" >&2
    exit 1
fi
