#!/bin/sh
# Fake Agent CLI — the test seam for the Agent Session subsystem (see
# electron/agent/profiles.ts `fake` profile). Prints how it was invoked, then
# echoes stdin lines until "exit" (exits 3) or EOF.
echo "ARGS:$*"
echo "MCP_URL:${KDASH_MCP_URL}"
echo "MCP_TOKEN:${KDASH_MCP_TOKEN}"
while IFS= read -r line; do
  if [ "$line" = "exit" ]; then
    exit 3
  fi
  echo "ECHO:$line"
done
