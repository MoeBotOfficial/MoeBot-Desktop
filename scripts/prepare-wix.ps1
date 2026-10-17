[CmdletBinding()]
param(
  [string]$Zip = (Join-Path $PSScriptRoot '..\..\wix314-binaries.zip')
)

$ErrorActionPreference = 'Stop'

$Zip = [System.IO.Path]::GetFullPath($Zip)
if (-not (Test-Path -LiteralPath $Zip)) {
  throw "未找到 WiX 工具包：$Zip`n请先下载 wix314-binaries.zip 并从 https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip 放到该路径。"
}

$target = Join-Path $env:LOCALAPPDATA 'tauri\WixTools314'
New-Item -ItemType Directory -Path $target -Force | Out-Null
Expand-Archive -LiteralPath $Zip -DestinationPath $target -Force

Get-ChildItem -LiteralPath $target -Filter '*.exe.config' | ForEach-Object {
  $text = Get-Content -LiteralPath $_.FullName -Raw
  $patched = [regex]::Replace($text, '(?s)<runtime>\s*<loadFromRemoteSources[^>]*/>\s*</runtime>', '')
  if ($patched -ne $text) {
    Set-Content -LiteralPath $_.FullName -Value $patched -NoNewline -Encoding utf8
    Write-Host "patched $($_.Name)"
  }
}

Write-Host "WiX tools ready at $target"
