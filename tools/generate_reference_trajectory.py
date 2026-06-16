#!/usr/bin/env python3
"""Generate py-ballisticcalc reference trajectory tables for J57AA profiles."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

from py_ballisticcalc import (
    Ammo,
    Angular,
    Atmo,
    Calculator,
    Distance,
    DragModel,
    Pressure,
    Shot,
    TableG1,
    TableG2,
    TableG5,
    TableG6,
    TableG7,
    TableG8,
    Temperature,
    Unit,
    Velocity,
    Weapon,
    Weight,
    Wind,
    loadMetricUnits,
)


PROFILES = {
    "223_55_vmax": {
        "name": "223 REM 55gr V-MAX",
        "bc": 0.255,
        "model": "G1",
        "velocity_ms": 990,
        "bullet_weight_g": 3.56,
        "baseline_mm": 20,
        "zero_range_m": 100,
        "min_energy_j": 850,
    },
    "556_62_fmj": {
        "name": "5.56 NATO 62gr FMJ",
        "bc": 0.304,
        "model": "G1",
        "velocity_ms": 920,
        "bullet_weight_g": 4.02,
        "baseline_mm": 20,
        "zero_range_m": 100,
        "min_energy_j": 900,
    },
    "243_95_sst": {
        "name": ".243 WIN 95gr SST",
        "bc": 0.355,
        "model": "G1",
        "velocity_ms": 940,
        "bullet_weight_g": 6.16,
        "baseline_mm": 20,
        "zero_range_m": 180,
        "min_energy_j": 1200,
    },
    "65cm_143_eldx": {
        "name": "6.5 Creedmoor 143gr ELD-X",
        "bc": 0.315,
        "model": "G7",
        "velocity_ms": 823,
        "bullet_weight_g": 9.27,
        "baseline_mm": 20,
        "zero_range_m": 200,
        "min_energy_j": 1500,
    },
    "308_168_match": {
        "name": ".308 WIN 168gr Match",
        "bc": 0.223,
        "model": "G7",
        "velocity_ms": 808,
        "bullet_weight_g": 10.89,
        "baseline_mm": 20,
        "zero_range_m": 100,
        "min_energy_j": 1600,
    },
    "300wm_178_eldx": {
        "name": ".300 WM 178gr ELD-X",
        "bc": 0.278,
        "model": "G7",
        "velocity_ms": 900,
        "bullet_weight_g": 11.53,
        "baseline_mm": 20,
        "zero_range_m": 200,
        "min_energy_j": 1800,
    },
    "375ct_350_elr": {
        "name": ".375 CheyTac 350gr ELR",
        "bc": 0.470,
        "model": "G7",
        "velocity_ms": 930,
        "bullet_weight_g": 22.68,
        "baseline_mm": 55,
        "zero_range_m": 300,
        "min_energy_j": 1500,
    },
    "408ct_419_elr": {
        "name": ".408 CheyTac 419gr ELR",
        "bc": 0.475,
        "model": "G7",
        "velocity_ms": 884,
        "bullet_weight_g": 27.15,
        "baseline_mm": 55,
        "zero_range_m": 300,
        "min_energy_j": 1600,
    },
    "50bmg_750_amax": {
        "name": ".50 BMG 750gr A-MAX",
        "bc": 0.520,
        "model": "G7",
        "velocity_ms": 860,
        "bullet_weight_g": 48.60,
        "baseline_mm": 70,
        "zero_range_m": 300,
        "min_energy_j": 2500,
    },
}

DRAG_TABLES = {
    "G1": TableG1,
    "G2": TableG2,
    "G5": TableG5,
    "G6": TableG6,
    "G7": TableG7,
    "G8": TableG8,
}


def build_shot(profile: dict, args: argparse.Namespace) -> tuple[Calculator, Shot]:
    table = DRAG_TABLES[profile["model"].upper()]
    drag_model = DragModel(
        profile["bc"],
        table,
        weight=Weight(profile["bullet_weight_g"], Unit.Gram),
    )
    ammo = Ammo(drag_model, mv=Velocity(profile["velocity_ms"], Unit.MPS))
    weapon = Weapon(sight_height=Distance(profile["baseline_mm"], Unit.Millimeter))
    atmo = Atmo(
        altitude=Distance(args.altitude_m, Unit.Meter),
        temperature=Temperature(args.temp_c, Unit.Celsius),
        pressure=Pressure(args.pressure_hpa, Unit.hPa),
        humidity=args.humidity_pct / 100,
    )
    calc = Calculator()
    zero_shot = Shot(
        ammo=ammo,
        weapon=weapon,
        atmo=atmo,
        look_angle=Angular(args.angle_deg, Unit.Degree),
    )
    calc.set_weapon_zero(zero_shot, Distance(profile["zero_range_m"], Unit.Meter))
    winds = []
    if args.cross_wind_ms:
        winds.append(
            Wind(
                Velocity(abs(args.cross_wind_ms), Unit.MPS),
                Angular(90 if args.cross_wind_ms > 0 else 270, Unit.Degree),
                Distance(args.max_range_m, Unit.Meter),
            )
        )
    shot = Shot(
        ammo=ammo,
        weapon=weapon,
        atmo=atmo,
        winds=winds,
        look_angle=Angular(args.angle_deg, Unit.Degree),
    )
    return calc, shot


def row_for(hit, range_m: int, profile: dict) -> dict:
    data = hit.get_at("distance", Distance(range_m, Unit.Meter))
    drop_mil = data.drop_angle >> Unit.Mil
    wind_mil = data.windage_angle >> Unit.Mil
    velocity_ms = data.velocity >> Unit.MPS
    energy_j = data.energy >> Unit.Joule
    return {
        "range_m": range_m,
        "time_s": round(float(data.time), 5),
        "drop_mil": round(drop_mil, 3),
        "wind_mil": round(wind_mil, 3),
        "velocity_ms": round(velocity_ms, 2),
        "energy_j": round(energy_j, 1),
        "energy_margin_pct": round(((energy_j - profile["min_energy_j"]) / profile["min_energy_j"]) * 100, 1)
        if profile["min_energy_j"] > 0
        else None,
    }


def generate(args: argparse.Namespace) -> dict:
    loadMetricUnits()
    profile = PROFILES[args.profile]
    calc, shot = build_shot(profile, args)
    hit = calc.fire(
        shot,
        trajectory_range=Distance(args.max_range_m, Unit.Meter),
        trajectory_step=Distance(args.step_m, Unit.Meter),
        raise_range_error=False,
    )
    rows = [row_for(hit, r, profile) for r in range(args.step_m, args.max_range_m + 1, args.step_m)]
    return {
        "reference": "py-ballisticcalc",
        "reference_version": "2.2.10",
        "profile_id": args.profile,
        "profile": profile,
        "environment": {
            "altitude_m": args.altitude_m,
            "temp_c": args.temp_c,
            "humidity_pct": args.humidity_pct,
            "pressure_hpa": args.pressure_hpa,
            "angle_deg": args.angle_deg,
            "cross_wind_ms": args.cross_wind_ms,
        },
        "rows": rows,
    }


def write_csv(path: Path, result: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=result["rows"][0].keys())
        writer.writeheader()
        writer.writerows(result["rows"])


def print_csv(result: dict) -> None:
    writer = csv.DictWriter(sys.stdout, fieldnames=result["rows"][0].keys())
    writer.writeheader()
    writer.writerows(result["rows"])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=PROFILES.keys(), default="308_168_match")
    parser.add_argument("--max-range-m", type=int, default=1000)
    parser.add_argument("--step-m", type=int, default=100)
    parser.add_argument("--altitude-m", type=float, default=200)
    parser.add_argument("--temp-c", type=float, default=25)
    parser.add_argument("--humidity-pct", type=float, default=50)
    parser.add_argument("--pressure-hpa", type=float, default=1013.25)
    parser.add_argument("--angle-deg", type=float, default=0)
    parser.add_argument("--cross-wind-ms", type=float, default=0)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--format", choices=["json", "csv"], default="json")
    args = parser.parse_args()

    result = generate(args)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        if args.format == "csv":
            write_csv(args.out, result)
        else:
            args.out.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    else:
        if args.format == "csv":
            print_csv(result)
        else:
            print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
