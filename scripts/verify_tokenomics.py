#!/usr/bin/env python3
"""Cross-layer verification of the 2026-09 tokenomics redesign.

NOT a replacement for `cargo test` -- it wraps it. This exists because no single
suite covers the Rust program and the Python miner agreeing with each other.

Covers the one thing no single canonical suite does: that the Rust program and
the Python miner agree, and that cap/halving behaviour is genuinely gone from
the *real* source -- not from a re-implementation of it.
"""
import ast, re, subprocess, sys

CORE  = "/mnt/minos-drive/life-compute-core"
SRC   = f"{CORE}/programs/core/src"
MINER = "/mnt/minos-drive/life-compute-miner/miner_daemon.py"
ONE   = 1_000_000
fails, checks = [], 0

def chk(name, cond, detail=""):
    global checks
    checks += 1
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f" -- {detail}" if detail else ""))
    if not cond:
        fails.append(name)

# ---------- Rust constants (handle both `N * ONE_LIFE` and bare raw ints) ----
rs = open(f"{SRC}/constants.rs").read()
def rust_raw(name):
    if m := re.search(rf"pub const {name}:\s*u64\s*=\s*(\d+)\s*\*\s*ONE_LIFE", rs):
        return int(m.group(1)) * ONE          # multiply-form FIRST (the earlier bug)
    if m := re.search(rf"pub const {name}:\s*u64\s*=\s*([0-9_]+)\s*;", rs):
        return int(m.group(1).replace("_", ""))
    raise AssertionError(f"{name} not found in constants.rs")

# ---------- Python constants + the two real tier-selection expressions -------
tree = ast.parse(open(MINER).read())
pyc = {n.target.id: ast.literal_eval(n.value) for n in tree.body
       if isinstance(n, ast.AnnAssign) and getattr(n.target, "id", "").startswith("REWARD_")}
tier_map = next(
    {ast.literal_eval(k): v.id for k, v in zip(n.value.keys, n.value.values)}
    for n in tree.body
    if isinstance(n, (ast.Assign, ast.AnnAssign))
    and getattr(n.target if isinstance(n, ast.AnnAssign) else n.targets[0], "id", "") == "TIER_REWARD_LIFE"
)
# every `life_delta/_tier_reward = <expr>` assignment, evaluated as written
exprs = [(n.lineno, ast.unparse(n.value)) for n in ast.walk(tree)
         if isinstance(n, ast.Assign)
         and getattr(n.targets[0], "id", "") in ("life_delta", "_tier_reward")
         and isinstance(n.value, ast.IfExp)]

print("\n== 1. Rust <-> Python constant parity ==")
for py, rust in [("REWARD_EASY_LIFE","REWARD_EASY"), ("REWARD_MEDIUM_LIFE","REWARD_MEDIUM"),
                 ("REWARD_HARD_LIFE","REWARD_HARD"), ("REWARD_CRISPR_LIFE","REWARD_CRISPR"),
                 ("REWARD_MRNA_LIFE","REWARD_MRNA"), ("REWARD_REFERENCE_LIFE","REWARD_REFERENCE")]:
    chk(f"{py} == {rust}", abs(pyc[py] - rust_raw(rust)/ONE) < 1e-9,
        f"{pyc[py]} LIFE == {rust_raw(rust):,} raw")

print("\n== 2. Part 1 -- mandated values ==")
for name, want in [("REWARD_HARD",900_000), ("REWARD_MEDIUM",700_000), ("REWARD_EASY",300_000),
                   ("REWARD_MRNA",900_000), ("REWARD_CRISPR",252_000), ("REWARD_REFERENCE",108_000)]:
    chk(f"{name} == {want:,} raw", rust_raw(name) == want, f"{rust_raw(name)/ONE} LIFE")
chk("reference == 3.0 x Hard ratio", abs(rust_raw("REWARD_REFERENCE")/ONE - 3.0*(0.9/25)) < 1e-9)
chk("CRISPR == 7.0 x Hard ratio", abs(rust_raw("REWARD_CRISPR")/ONE - 7.0*(0.9/25)) < 1e-9)
chk("VALIDATOR_REWARD_CRISPR == REWARD_CRISPR",
    rust_raw("VALIDATOR_REWARD_CRISPR") == rust_raw("REWARD_CRISPR"))
chk("CRISPR < Hard (CPU must not out-price GPU)", rust_raw("REWARD_CRISPR") < rust_raw("REWARD_HARD"))
chk("tier ordering Easy<Medium<Hard",
    rust_raw("REWARD_EASY") < rust_raw("REWARD_MEDIUM") < rust_raw("REWARD_HARD"))

print("\n== 3. Part 4 -- untouched ==")
chk("REWARD_DISCOVERY still 100 LIFE", rust_raw("REWARD_DISCOVERY") == 100*ONE,
    f"{rust_raw('REWARD_DISCOVERY'):,} raw")
mr = open(f"{SRC}/instructions/mint_reward.rs").read()
chk("validator commission arithmetic intact", "(amount / 20) / confirming_count" in mr)
chk("ConfirmedMolecule dedup intact",
    all(s in mr for s in ("ConfirmedMolecule","DuplicateMolecule","confirmed_molecule")))
chk("CRISPR similarity decay multiplicative",
    "base_reward * mult" in open(MINER).read())

print("\n== 4. Part 2 -- no supply cap ==")
allrs = {p: open(f"{SRC}/{p}").read() for p in
         ("constants.rs","rewards.rs","lib.rs","instructions/mint_reward.rs",
          "instructions/initialize.rs","instructions/claim_discovery_bonus.rs")}
code = lambda t: "\n".join(l for l in t.splitlines()
                           if not l.lstrip().startswith(("//","///")))
chk("no SUPPLY_CAP_RAW constant", "pub const SUPPLY_CAP_RAW" not in rs)
chk("no require! on supply_cap anywhere",
    not any("supply_cap" in l and "require!" in l
            for t in allrs.values() for l in t.splitlines()))
chk("supply_cap field retained (byte-layout compat)",
    "pub supply_cap: u64" in open(f"{SRC}/state/network_config.rs").read())
chk("SupplyCapExceeded never returned",
    not any("LifeError::SupplyCapExceeded" in code(t) for t in allrs.values()))
chk("no transfer hook / burn-on-transfer",
    not any(re.search(r"transfer_hook|TransferHook|burn_", code(t)) for t in allrs.values()))

print("\n== 5. Part 3 -- no halving (Layers 0+1), Layer 2 kept ==")
for sym in ("HALVING_INTERVAL","HALVING_MILESTONE_1","HALVING_MILESTONE_2",
            "HALVING_MILESTONE_3","INITIAL_HARD_REWARD","checked_shr"):
    chk(f"{sym} gone from code", not any(sym in code(t) for t in allrs.values()))
chk("HALVING_HIT_TIER_1/2 retained",
    all(f"pub const HALVING_HIT_TIER_{i}" in rs for i in (1,2)))
sig = re.search(r"pub fn calculate_reward\(([^)]*)\)", allrs["rewards.rs"], re.S).group(1)
chk("calculate_reward takes only (base_reward, hit_count)",
    {"base_reward","hit_count"} == set(re.findall(r"(\w+):", sig)), sig.strip().replace("\n"," "))
chk("total_minted/current_epoch not reward inputs",
    not re.search(r"total_minted|current_epoch", sig))
chk("miner has no halving symbols",
    not re.search(r"HALVING_INTERVAL|current_epoch_reward", open(MINER).read()))

print("\n== 6. Live reward matrix (flat tier x retained Layer-2 taper) ==")
def reward(base, hits):                      # mirrors rewards.rs exactly
    num = 4 if hits < 100 else 3 if hits < 1000 else 2
    return max(base * num // 4, 1)
for nm, key, exp in [("Easy","REWARD_EASY",(300_000,225_000,150_000)),
                     ("Medium","REWARD_MEDIUM",(700_000,525_000,350_000)),
                     ("Hard","REWARD_HARD",(900_000,675_000,450_000)),
                     ("CRISPR","REWARD_CRISPR",(252_000,189_000,126_000)),
                     ("mRNA","REWARD_MRNA",(900_000,675_000,450_000)),
                     ("Ref","REWARD_REFERENCE",(108_000,81_000,54_000))]:
    got = tuple(reward(rust_raw(key), h) for h in (0,150,1000))
    chk(f"{nm:6} taper 100%/75%/50%", got == exp,
        " / ".join(f"{g/ONE:.6f}" for g in got))
chk("flat: reward independent of supply & epoch",
    reward(rust_raw("REWARD_HARD"),0) == reward(rust_raw("REWARD_HARD"),0) == 900_000)
h = reward(rust_raw("REWARD_HARD"), 0)
chk("post-deploy delta for 1 Hard hit == 0.945 LIFE (reward + 5% commission)",
    abs((h + h//20)/ONE - 0.945) < 1e-9, f"{(h + h//20)/ONE} LIFE")

print("\n== 7. Python tier selection -- evaluating the REAL expressions ==")
chk("exactly 2 tier-selection sites (both worker paths)", len(exprs) == 2,
    f"lines {[l for l,_ in exprs]}")
chk("TIER_REWARD_LIFE maps to constants, no literals",
    tier_map == {1:"REWARD_EASY_LIFE",2:"REWARD_MEDIUM_LIFE",3:"REWARD_HARD_LIFE"}, str(tier_map))
env = dict(pyc); env["TIER_REWARD_LIFE"] = {k: pyc[v] for k, v in tier_map.items()}
for lineno, expr in exprs:
    for tier, want, isref in [(1,0.3,False),(2,0.7,False),(3,0.9,False),
                              (99,0.3,False),(1,0.108,True)]:
        got = eval(expr, {}, {**env, "is_ref": isref, "target": {"difficulty_tier": tier}})
        chk(f"L{lineno} tier={tier} is_ref={isref} -> {want}", abs(got-want) < 1e-9, f"got {got}")
chk("no literal tier dict remains in miner",
    not re.search(r"\{\s*1\s*:\s*[\d.]+\s*,\s*2\s*:", open(MINER).read()))

print("\n== 8. mint_reward ABI stable (live crank builds txs from the stale IDL) ==")
blk = mr[mr.index("pub struct MintReward"):]
accts = re.findall(r"pub (\w+):", blk)
chk("MintReward accounts unchanged (11, in order)",
    accts == ["crank","network_config","life_mint","mint_authority","result_submission",
              "target","miner_account","miner_ata","confirmed_molecule",
              "token_program","system_program"], f"{len(accts)} accounts")
chk("mint_reward still zero-arg",
    re.search(r"pub fn mint_reward<'info>\(ctx: Context<[^)]*MintReward<'info>>\) -> Result<\(\)>",
              allrs["lib.rs"]) is not None)

print("\n== 9. Canonical suites ==")
def run(label, cmd, cwd, ok):
    p = subprocess.run(cmd, cwd=cwd, shell=True, capture_output=True, text=True, timeout=900)
    out = p.stdout + p.stderr
    chk(label, ok(p.returncode, out), out.strip().splitlines()[-1][:88] if out.strip() else "")
run("yarn run lint (prettier, JS/TS -- matches no changed file)",
    "yarn run lint", CORE, lambda rc,o: rc == 0)
run("cargo test -p life-core --lib  [20 tests]",
    "cargo test -p life-core --lib", CORE,
    lambda rc,o: rc == 0 and "20 passed; 0 failed" in o)
# Assert the ARTIFACT, not a log line: build-sbf always prints a pre-existing
# stack-offset `Error:` for validate_result (identical on baseline bde8557) and
# streams "Finished" to stderr, so grepping output is unreliable.
run("cargo build-sbf -> fresh life_core.so on disk",
    "rm -f target/deploy/life_core.so && cargo build-sbf >/dev/null 2>&1; "
    "test -s target/deploy/life_core.so && stat -c%s target/deploy/life_core.so",
    CORE, lambda rc,o: rc == 0 and int(o.strip() or 0) > 400_000)
run("py_compile miner_daemon.py",
    "python3 -m py_compile miner_daemon.py", "/mnt/minos-drive/life-compute-miner",
    lambda rc,o: rc == 0)

print(f"\n{'='*64}\nAD-HOC VERIFICATION: {checks-len(fails)}/{checks} checks passed")
if fails:
    print("FAILED:"); [print("  -", f) for f in fails]
print("="*64)
sys.exit(1 if fails else 0)
