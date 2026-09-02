# StarBrawl — Backend

**Live:** <https://starbrawl.slippylabs.com/>

## What it is

- StarBrawl — a Melee-inspired two-player platform fighter.
- Data-driven roster and stages.
- Rollback netcode for online play.

## How it works

Rollback netcode (since v1.1.0) is the hard part of this repo. Two things it depends on:

- **The edge-field prediction rule** — prediction has to cover the edge fields, not just position and velocity, or a rollback resimulates into a different state than the one it replaced.
- **Four state-clone traps** — anything held by reference rather than cloned will alias across a rollback and corrupt the resimulation silently. Every new piece of match state has to be added to the clone.

## Running it locally

```
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python app.py
```

## Tests

```
node test/rollback_test.mjs
node test/rollback_state_test.mjs
node test/rollback_netplay_test.mjs
```

## Deployment

| | |
| --- | --- |
| systemd unit | `starbrawl.service` |
| Bind | `127.0.0.1:8011` (gunicorn, proxied by nginx) |
| Deployed to | `/opt/starbrawl` |

`/opt/starbrawl` is a **plain copy, not a checkout**, so it can drift from this repo in either direction. Check which side is newer before deploying over it.

## Notes

Rollback is genuinely the right model here because the game is a deterministic two-player fighter. It is **not** the right model for Slime Sports — see `slimesoccer-dev` for why.

`/opt/starbrawl` is mode 0750 and root-owned since the September 2026 permissions pass, so it does not show up in a plain glob and cannot be read without `sudo`.

---

Part of [Slippy Labs](https://slippylabs.com). Private repo — this README is internal documentation, not a public listing.
