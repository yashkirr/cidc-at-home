#!/bin/bash
# Double-click on a Mac to open CI/CD at home in your browser. Keep the window open while it runs.
cd "$(dirname "$0")" && exec node server.mjs "$@"
