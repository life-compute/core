# Redeploy Plan — Tokenomics Redesign (2026-09-11)

Commit: `9a54503` (program) · `b63f52e` (miner/docs) · `2045087` (website)
Rollback baseline: `bde8557`

## Pre-flight (all verified before writing this doc)

| Check | Result |
|---|---|
| `cargo test -p life-core --lib` | 20/20 pass |
| `cargo build-sbf` | `life_core.so` = 539,792 bytes |
| Deployed ProgramData length | 543,592 bytes — new .so is **smaller**, no realloc needed |
| Upgrade authority | `4zn1WQZy48ysUeSo2WCFwF9LmoPhZedZq7iKLcAH3pc8` (unchanged) |
| Deployer balance | 8.7455 SOL (ample) |
| Program-ID keypair sha256 | `828f769b…f49fe` — identical to pre-edit, program address preserved |
| `anchor build` IDL generation | FAILS — **pre-existing**, identical 23 errors on baseline `bde8557`. BPF artifact unaffected. Use `cargo build-sbf`, not `anchor build`. |
| NetworkConfig byte layout | UNCHANGED — `supply_cap` field retained as vestigial no-op |

## Why no account migration is needed

`NetworkConfig::supply_cap` (bytes 72–79) was **kept**. Deleting it would shift
every later field, and `miner_daemon.py` reads `total_miners_registered` at a
hardcoded **offset 280**. The field stays; only the `require!` checks were
removed. The already-deployed account is byte-compatible with the new program.

Post-deploy this must still read correctly: `miners = 2`, `validators = 1`.

## Sequence

Rewards change the instant the program is upgraded. Stop the mint crank first so
no submission is minted mid-swap at an ambiguous rate.

```bash
# 1. Freeze minting (crank is the only thing that calls mint_reward)
pm2 stop life-mint-crank

# 2. Record pre-deploy state — keep this output
solana program show 74RHjg1zYgN9zuVykde4SK2ERiRgNkouATW9MmQDLRWf --url https://api.devnet.solana.com
python3 - <<'PY'
import json,urllib.request,base64,struct
rpc=lambda m,p: json.load(urllib.request.urlopen(urllib.request.Request(
  "https://api.devnet.solana.com",data=json.dumps({"jsonrpc":"2.0","id":1,"method":m,"params":p}).encode(),
  headers={"Content-Type":"application/json"}),timeout=30)).get("result")
raw=base64.b64decode(rpc("getAccountInfo",["BgW8KxfMmEEDPwuQiXUBdUATXqtSVT3TYDhf9qXDpbrt",{"encoding":"base64"}])["value"]["data"][0])
for n,o in [("supply_cap",72),("total_minted",80),("current_epoch",88),("miners",280),("validators",288)]:
    print(f"{n:>14}: {struct.unpack_from('<Q',raw,o)[0]:,}")
PY

# 3. Upgrade (per UPGRADE_AUTHORITY.md)
cd /mnt/minos-drive/life-compute-core
anchor upgrade target/deploy/life_core.so \
  --program-id 74RHjg1zYgN9zuVykde4SK2ERiRgNkouATW9MmQDLRWf \
  --provider.cluster devnet

# 4. Confirm new slot + unchanged authority
solana program show 74RHjg1zYgN9zuVykde4SK2ERiRgNkouATW9MmQDLRWf --url https://api.devnet.solana.com

# 5. Re-read NetworkConfig — miners MUST still be 2, validators 1.
#    If these are garbage, the byte layout broke: ROLL BACK IMMEDIATELY.
#    (re-run the python block from step 2)

# 6. Restart miner to pick up the new Python constants, then the crank
pm2 restart life-miner
pm2 restart life-mint-crank

# 7. Confirm the miner logs the new scale
pm2 logs life-miner --lines 40 --nostream | grep TOKENOMICS
# expect: Flat rewards — Easy: 0.3 | Medium: 0.7 | Hard: 0.9 | CRISPR: 0.252 |
#         mRNA: 0.9 | Ref: 0.108 $LIFE (flat forever — no halving, no supply cap)
```

## Post-deploy verification with real data (do not skip)

Wait for one confirmed mint, then check the actual on-chain delta:

```bash
# total_minted delta for a single Hard-tier confirmation should be
#   0.9 LIFE + 5% validator commission = 0.945 LIFE  (hit_count < 100)
# NOT 25.x — if you see ~26, the old program is still live.
```

Also confirm a `RewardMinted` event shows `amount_raw = 900000` (not
`25000000`) and `supply_tier = 0`.

## Rollback

```bash
cd /mnt/minos-drive/life-compute-core
git stash && git checkout bde8557
cargo build-sbf
anchor upgrade target/deploy/life_core.so \
  --program-id 74RHjg1zYgN9zuVykde4SK2ERiRgNkouATW9MmQDLRWf \
  --provider.cluster devnet
git checkout main && git stash pop
pm2 restart life-miner life-mint-crank
```

The old program re-enforces `supply_cap`. Since `total_minted` (~170k) is far
below 21,000,000, rollback is safe — no already-minted supply becomes invalid.

## Open items (NOT done, flagged for decision)

1. **`freeze_authority` is live** on mint `5Ujmqb…9vc3`, set to the program PDA
   (`initialize.rs:82`). Token accounts *can* be frozen, which sits in tension
   with "freely tradeable". Left untouched — revoking is irreversible.
2. **Program-ID keypair is gitignored** and exists only at
   `target/deploy/life_core-keypair.json` on this rig. Back it up off-rig.
3. **IDL is stale.** `life_core.json` in the miner repo still describes the old
   `calculate_reward` shape. The `idl-build` failure is pre-existing and blocks
   regeneration; the miner does not depend on the IDL for reward math, but any
   JS client that does should be checked.
4. **Validator commission** (`amount/20` in `mint_reward.rs`) untouched per
   instruction — handle on the 4060 rig. Note it now pays 5% of 0.9 rather than
   5% of 25, so validator income drops by the same 27.78x.
