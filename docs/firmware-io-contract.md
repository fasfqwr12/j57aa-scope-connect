# 固件 I/O 合约草案

## App -> 弹道/决策中心输入

字段应由 C 决策中心统一消费，UI 不重复做枪瞄判定。

```json
{
  "bc": 0.315,
  "model": "G7",
  "velocity_ms": 823,
  "bullet_weight_g": 9.27,
  "baseline_mm": 20,
  "zero_range_m": 200,
  "altitude_m": 200,
  "temp_c": 25,
  "humidity_pct": 50,
  "pressure_pa": 101325,
  "head_wind_ms": 0,
  "cross_wind_ms": 2.5,
  "angle_deg": 0,
  "range_m": 420,
  "target_width_m": 1.25,
  "min_energy_j": 1500,
  "zoom_x": 10,
  "reticle_min_range_m": 100,
  "reticle_max_range_m": 1500,
  "reticle_mil_per_row_at_10x": 1.28,
  "reticle_rows": 17,
  "reticle_max_wind_cols": 6
}
```

## 决策中心 -> App/HUD 输出

```json
{
  "energy_j": 1780,
  "final_velocity_ms": 620,
  "shot_status": 1,
  "hud_fault": 0,
  "show_x": false,
  "show_aim_dot": true,
  "can_shoot": true,
  "reticle_row": 4,
  "reticle_col": 2,
  "reticle_side": 1,
  "reticle_x_pct": 57.2,
  "reticle_y_pct": 55.4,
  "elevation_mil": 5.1,
  "windage_mil": 1.8
}
```

状态枚举沿用当前 C 核心：

- `shot_status`: `0 WAIT`, `1 VALID`, `2 MARGINAL`, `3 NO_SHOT`, `4 OFF`
- `hud_fault`: `0 NONE`, `1 TOO_FAR`, `2 ZOOM_OUT`, `3 PARAM`

## Profile/DOPE 写入命令建议

现有公开协议已有传感器查询、测量结果、弹道查询/回复，但缺少 App 写入 Profile/DOPE 的定版命令。建议新增：

- `0x20`: 写入 Profile 头，包含 profile slot、名称、单位、版本。
- `0x21`: 写入弹道参数，包含 BC、模型、初速、弹重、镜高、归零、SCI 阈值。
- `0x22`: 写入 HUD 分区设置，包含 10 区开关、DIST/WIND 互换、单位。
- `0x23`: 写入 DOPE 表分片。
- `0x24`: 提交并校验 CRC。
- `0x25`: 回读当前 Profile 摘要。

在命令未定版前，App 只做本地 Profile 保存和弹道预览，不伪造“已写入固件”。
