#!/usr/bin/env bash
# Run the bot in foreground with .env loaded via dotenv
# Usage: ./run.sh

node -r dotenv/config index.js
