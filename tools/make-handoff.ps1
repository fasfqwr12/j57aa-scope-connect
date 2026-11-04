# 生成 J57AA 网页 OTA 交接包：源码快照 + 完整 git 历史 + 先读我 + SHA256 清单 → zip
# 用法（仓库根目录）：powershell -ExecutionPolicy Bypass -File tools\make-handoff.ps1
# 注意：全部内容从 git 产物导出（git archive / git bundle），避免把本机 Tipray 密文文件拷出去
param(
  [string]$OutRoot = 'E:\phase1\debug_toll\_handoff',
  [string]$Name = '',
  [string]$Tag = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $repo
try {
  if (-not $Name) { $Name = 'J57AA-WebOTA-handoff-' + (Get-Date -Format 'yyyyMMdd') }
  $pkg = Join-Path $OutRoot $Name
  $zip = Join-Path $OutRoot ($Name + '.zip')
  $ref = if ($Tag) { $Tag } else { 'HEAD' }
  if (Test-Path $pkg) { Remove-Item $pkg -Recurse -Force }
  if (Test-Path $zip) { Remove-Item $zip -Force }
  New-Item -ItemType Directory -Force -Path (Join-Path $pkg 'j57aa-scope-connect') | Out-Null

  # 1) 源码快照（明文）
  $snap = Join-Path $env:TEMP ('snap_' + [guid]::NewGuid().ToString('N') + '.zip')
  git archive --format=zip -o $snap $ref
  if ($LASTEXITCODE -ne 0) { throw 'git archive 失败' }
  Expand-Archive -Path $snap -DestinationPath (Join-Path $pkg 'j57aa-scope-connect') -Force
  Remove-Item $snap -Force

  # 2) 完整历史
  git bundle create (Join-Path $pkg 'j57aa-scope-connect.bundle') --all | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'git bundle 失败' }

  # 3) 先读我（仓库里维护，打包时改名放顶层）
  $quick = Join-Path $repo 'docs\HANDOFF-QUICKSTART.md'
  if (Test-Path $quick) { Copy-Item $quick (Join-Path $pkg '00-先读我.md') -Force }

  # 4) SHA256 清单
  $lines = Get-ChildItem $pkg -Recurse -File |
    Sort-Object FullName |
    ForEach-Object {
      $h = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower()
      $rel = $_.FullName.Substring($pkg.Length + 1) -replace '\\', '/'
      "$h  $rel"
    }
  Set-Content -Path (Join-Path $pkg 'SHA256SUMS.txt') -Value $lines -Encoding utf8

  # 5) 打包（.NET ZipFile：非 ASCII 文件名走 UTF-8，不会被代码页搞坏）
  [System.IO.Compression.ZipFile]::CreateFromDirectory($pkg, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $true)

  $head = git log -1 --format='%h %s'
  "包目录: $pkg"
  "压缩包: $zip"
  "大小:   {0:N2} MB" -f ((Get-Item $zip).Length / 1MB)
  "文件数: {0} (校验条目 {1})" -f (Get-ChildItem (Join-Path $pkg 'j57aa-scope-connect') -Recurse -File).Count, $lines.Count
  "基准:   $ref → $head"
} finally { Pop-Location }
