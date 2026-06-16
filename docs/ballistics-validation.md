# 弹道算法验证流程

## 参考基准

本项目用开源 [`py-ballisticcalc`](https://github.com/o-murphy/py-ballisticcalc) / [PyPI](https://pypi.org/project/py-ballisticcalc/) 作为第一层参考解算器，版本固定为 `2.2.10`。它提供 G1/G7 等阻力表、点质量 3DoF 轨迹计算、风偏、末速、能量和飞行时间输出。

网页内的 JS 解算只用于交互预览和 HUD 位置估算，不作为最终弹道认证。固件 C 算法需要对齐参考表和实测靶纸。

## 生成参考表

安装参考库：

```powershell
python -m pip install py-ballisticcalc==2.2.10
```

生成 `.308 WIN 168gr Match` 参考表：

```powershell
python tools\generate_reference_trajectory.py --profile 308_168_match --max-range-m 1000 --step-m 100 --out data\reference\308_168_match.json
```

带横风参考：

```powershell
python tools\generate_reference_trajectory.py --profile 65cm_143_eldx --cross-wind-ms 4 --max-range-m 1000 --step-m 100 --format csv --out data\reference\65cm_143_eldx_wind4.csv
```

输出字段：

- `range_m`
- `time_s`
- `drop_mil`
- `wind_mil`
- `velocity_ms`
- `energy_j`
- `energy_margin_pct`

## 回归对比口径

同一组输入必须同时跑三份结果：

1. `py-ballisticcalc` 参考表
2. 固件 C 解算输出
3. 网页 JS 预览输出

核心对比项：

- 下坠角 `drop_mil`
- 风偏角 `wind_mil`
- 飞行时间 `time_s`
- 末速 `velocity_ms`
- 能量 `energy_j`
- HUD 阵列行列和 SCI X 状态

建议初始误差门限：

- 100-300 m：下坠/风偏误差 <= 0.15 mil
- 300-600 m：下坠/风偏误差 <= 0.25 mil
- 600-1000 m：下坠/风偏误差 <= 0.40 mil
- 末速误差 <= 3%
- 能量误差 <= 6%

超限时优先排查：

- 单位：m/yards、m/s/fps、g/grain、Pa/hPa
- BC 模型：G1/G7 是否选错
- 零距和镜高：归零距离、瞄准线高度
- 大气：气压、温度、湿度、海拔
- 风向定义：横风正负、风从哪边来

## 实测闭环

靶场验证必须记录：

- 枪管长度、弹药批次、弹头型号
- 测速仪初速，至少 10 发平均值和标准差
- 实测镜高
- 归零距离和归零靶纸
- 温度、气压、湿度、海拔
- 100/200/300/500/800 m 靶纸落点

校准顺序：

1. 先用测速仪修正初速。
2. 用 100 m 或 200 m 靶纸确认归零。
3. 用 300-600 m 落点反校 BC 或阻力模型。
4. 用 800 m 以上验证跨音速前后的稳定性。
5. 最后验证 HUD 阵列行列、红点位置、NO SHOT X、TOO FAR/ZOOM OUT。

只有参考表、固件 C、实测靶纸三方一致时，才能认为这组枪弹 Profile 可用于正式配置。
