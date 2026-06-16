#!/usr/bin/env python3
"""Compare py-ballisticcalc reference output with the browser JS preview."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from generate_reference_trajectory import PROFILES, generate


ROOT = Path(__file__).resolve().parents[1]


def js_preview(profile: dict, args: argparse.Namespace) -> dict:
    payload = {
        **profile,
        "range_m": args.range_m,
        "altitude_m": args.altitude_m,
        "temp_c": args.temp_c,
        "humidity_pct": args.humidity_pct,
        "pressure_pa": args.pressure_hpa * 100,
        "cross_wind_ms": args.cross_wind_ms,
        "angle_deg": args.angle_deg,
        "reticle_max_range_m": args.reticle_max_range_m,
        "reticle_mil_per_row_at_10x": args.reticle_mil_per_row_at_10x,
        "zoom_x": args.zoom_x,
    }
    proc = subprocess.run(
        ["node", str(ROOT / "tools" / "js_preview_once.mjs")],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=True,
        cwd=ROOT,
    )
    return json.loads(proc.stdout)


def status_for(ref: dict, js: dict, profile: dict) -> dict:
    energy_ok_ref = ref["energy_j"] >= profile["min_energy_j"]
    energy_ok_js = js["energy_j"] >= profile["min_energy_j"]
    return {
        "reference_can_shoot_by_energy": energy_ok_ref,
        "js_can_shoot_by_energy": energy_ok_js,
        "energy_status_match": energy_ok_ref == energy_ok_js,
        "js_can_shoot_hud": bool(js["can_shoot"]),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=PROFILES.keys(), default="408ct_419_elr")
    parser.add_argument("--range-m", type=int, default=2000)
    parser.add_argument("--altitude-m", type=float, default=0)
    parser.add_argument("--temp-c", type=float, default=15)
    parser.add_argument("--humidity-pct", type=float, default=50)
    parser.add_argument("--pressure-hpa", type=float, default=1013.25)
    parser.add_argument("--angle-deg", type=float, default=0)
    parser.add_argument("--cross-wind-ms", type=float, default=0)
    parser.add_argument("--reticle-max-range-m", type=float, default=2200)
    parser.add_argument("--reticle-mil-per-row-at-10x", type=float, default=1.9)
    parser.add_argument("--zoom-x", type=float, default=10)
    args = parser.parse_args()

    profile = PROFILES[args.profile]
    ref_args = argparse.Namespace(
        profile=args.profile,
        max_range_m=args.range_m,
        step_m=args.range_m,
        altitude_m=args.altitude_m,
        temp_c=args.temp_c,
        humidity_pct=args.humidity_pct,
        pressure_hpa=args.pressure_hpa,
        angle_deg=args.angle_deg,
        cross_wind_ms=args.cross_wind_ms,
    )
    ref = generate(ref_args)["rows"][-1]
    js = js_preview(profile, args)
    deltas = {
        "drop_mil": round(js["drop_mil"] - ref["drop_mil"], 3),
        "velocity_ms": round(js["velocity_ms"] - ref["velocity_ms"], 2),
        "energy_j": round(js["energy_j"] - ref["energy_j"], 1),
        "time_s": round(js["time_s"] - ref["time_s"], 3),
    }
    closure = {
        "profile_id": args.profile,
        "range_m": args.range_m,
        "profile": profile,
        "reference": ref,
        "js_preview": {k: round(v, 3) if isinstance(v, float) else v for k, v in js.items()},
        "deltas": deltas,
        "status": status_for(ref, js, profile),
        "note": "JS preview is not the certified solver; firmware C must close against py-ballisticcalc and range data.",
    }
    print(json.dumps(closure, indent=2, ensure_ascii=False))

    if not closure["status"]["energy_status_match"]:
        sys.exit(2)


if __name__ == "__main__":
    main()
