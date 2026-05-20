#!/usr/bin/env bash
# Keepalive loop: restart the bot if it exits (runs in the current terminal)
# Usage: ./run-keepalive.sh

while true; do
  echo "Starting wishlist-bot ($(date))"
  node -r dotenv/config index.js
  echo "Process exited with code $? — restarting in 1s..."
  sleep 1
done
