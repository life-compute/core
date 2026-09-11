#!/usr/bin/env bash
# life_mint_crank_loop.sh — runs mint_reward crank on repeat
#
# PM2 manages restart on crash.  This script handles the steady-state loop:
#   1. Run the crank (drains all Confirmed + reward_minted=false PDAs)
#   2. Sleep DELAY seconds
#   3. Repeat forever
#
# Between passes the RPC needs to breathe; 120s lets devnet rate-limits clear
# and gives time for new validator confirmations to land before the next scan.
# On mainnet you'd lower this to 30–60s with a private RPC.

DELAY="${MINT_CRANK_DELAY:-120}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "[crank-loop] starting — pass interval=${DELAY}s  dir=${SCRIPT_DIR}"

while true; do
  echo ""
  echo "[crank-loop] $(date -u '+%Y-%m-%dT%H:%M:%SZ') — running mint_reward crank"
  node "${SCRIPT_DIR}/life_mint_reward.js"
  EXIT=$?
  if [ "$EXIT" -ne 0 ]; then
    echo "[crank-loop] crank exited with code $EXIT — sleeping before retry"
  else
    echo "[crank-loop] crank pass complete — sleeping ${DELAY}s"
  fi
  sleep "$DELAY"
done
