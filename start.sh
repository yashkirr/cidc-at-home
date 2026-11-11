#!/usr/bin/env bash
# Linux, a server, or a terminal anywhere: ./start.sh [/path/to/repo]
cd "$(dirname "$0")" && exec node server.mjs "$@"
