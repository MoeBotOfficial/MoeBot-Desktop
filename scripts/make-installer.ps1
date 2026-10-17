#Requires -Version 7
<#
.SYNOPSIS
    Builds the MoeBot desktop executable and wraps it in an Inno Setup installer.

.DESCRIPTION
    Mirrors scripts/prepare-wix.ps1 for the MSI, but emits an Inno Setup .exe:

      1. npx tauri build --no-bundle   -> src-tauri\target\release\moebot-desktop.exe
      2. ISCC.exe scripts\installer.iss -> src-tauri\target\release\bundle\inno\*_setup.exe

    The Microsoft Edge WebView2 bootstrapper is vendored next to the installer script
    so the resulting setup works on a machine without internet access. Use
    -SkipWebView2Bundle to leave it out and rely on the download fallback instead.

.EXAMPLE
    pwsh -NoProfile -File scripts/make-installer.ps1
.EXAMPLE
    pwsh -NoProfile -File scripts/make-installer.ps1 -SkipBuild
#>
[CmdletBinding()]
param(
    # Reuse the executable that is already in src-tauri\target\release.
    [switch]$SkipBuild,

    # Do not embed the WebView2 bootstrapper (smaller setup, needs internet on the
    # target machine when WebView2 is missing).
    [switch]$SkipWebView2Bundle,

    [string]$IsccPath = 'F:\Inno Setup 6\ISCC.exe'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue'

$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $projectRoot 'src-tauri\target\release'
$exePath = Join-Path $releaseDir 'moebot-desktop.exe'
$loaderPath = Join-Path $releaseDir 'WebView2Loader.dll'
$issPath = Join-Path $PSScriptRoot 'installer.iss'
$bootstrapperPath = Join-Path $PSScriptRoot 'MicrosoftEdgeWebview2Setup.exe'
$webView2Url = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703'

$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
Write-Output "MoeBot desktop installer build - version $version"

# --- find the Inno Setup compiler ------------------------------------------------

if (-not (Test-Path -LiteralPath $IsccPath)) {
    $onPath = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($onPath) {
        $IsccPath = $onPath.Source
    }
    else {
        throw "ISCC.exe not found. Install Inno Setup 6 or pass -IsccPath <path to ISCC.exe>."
    }
}
Write-Output "compiler: $IsccPath"

# --- build the executable --------------------------------------------------------

if ($SkipBuild) {
    Write-Output 'skipping the tauri build (-SkipBuild)'
}
else {
    # The GNU toolchain needs its linker on PATH; both locations only exist on the
    # machine this project is developed on, so they are applied best effort.
    $mingw = 'L:\obsidian-master\mingw64\bin'
    if (Test-Path -LiteralPath $mingw) { $env:PATH = "$mingw;$env:PATH" }
    if (-not $env:RUSTUP_TOOLCHAIN) { $env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-gnu' }
    if (-not $env:CARGO_HOME -and (Test-Path -LiteralPath 'L:\Rust\.cargo')) { $env:CARGO_HOME = 'L:\Rust\.cargo' }

    Push-Location $projectRoot
    try {
        & npx tauri build --no-bundle
        if ($LASTEXITCODE -ne 0) { throw "tauri build failed with exit code $LASTEXITCODE" }
    }
    finally {
        Pop-Location
    }
}

foreach ($required in @($exePath, $loaderPath)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "missing $required" }
}

# --- warn when the executable predates the sources --------------------------------

$exeTime = (Get-Item -LiteralPath $exePath).LastWriteTimeUtc
$staleInputs = @(
    Get-ChildItem -LiteralPath (Join-Path $projectRoot 'src-tauri\src') -File -Recurse -ErrorAction SilentlyContinue
    Get-Item -LiteralPath (Join-Path $projectRoot 'src-tauri\Cargo.toml'), (Join-Path $projectRoot 'src-tauri\tauri.conf.json')
    Get-ChildItem -LiteralPath $PSScriptRoot -File -Include *.js, *.mjs, *.css
) | Where-Object { $_.LastWriteTimeUtc -gt $exeTime }
if ($staleInputs) {
    Write-Warning "the packaged executable is older than: $($staleInputs.Name -join ', ') - rebuild without -SkipBuild"
}

# --- vendor the WebView2 bootstrapper ---------------------------------------------

$defines = @("/DAppVersion=$version")

if ($SkipWebView2Bundle) {
    $defines += '/DSkipWebView2Bundle=1'
    Write-Output 'WebView2 bootstrapper: not embedded (-SkipWebView2Bundle)'
}
else {
    if (-not (Test-Path -LiteralPath $bootstrapperPath)) {
        Write-Output "downloading the WebView2 bootstrapper -> $bootstrapperPath"
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $webView2Url -OutFile $bootstrapperPath -UseBasicParsing
    }
    if (-not (Test-Path -LiteralPath $bootstrapperPath)) {
        throw "could not vendor the WebView2 bootstrapper; download it manually from $webView2Url or rerun with -SkipWebView2Bundle"
    }
    Write-Output ("WebView2 bootstrapper: {0:N0} bytes" -f (Get-Item -LiteralPath $bootstrapperPath).Length)
}

# --- compile ----------------------------------------------------------------------

& $IsccPath $defines $issPath
if ($LASTEXITCODE -ne 0) { throw "ISCC failed with exit code $LASTEXITCODE" }

$outputDir = Join-Path $releaseDir 'bundle\inno'
$setup = Get-ChildItem -LiteralPath $outputDir -Filter '*.exe' |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
if (-not $setup) { throw "no installer produced in $outputDir" }

$hash = (Get-FileHash -LiteralPath $setup.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Output ''
Write-Output 'installer ready:'
Write-Output "  $($setup.FullName)"
Write-Output ("  {0:N0} bytes ({1:N2} MiB)" -f $setup.Length, ($setup.Length / 1MB))
Write-Output "  sha256 $hash"
