[CmdletBinding()]
param(
    [string]$Version = 'latest',
    [string]$Repo = 'tapeo/corami',
    [string]$Prefix = "$env:USERPROFILE\.corami\bin",
    [string]$Client = '',
    [string]$Join = '',
    [switch]$SkipSetup
)

$ErrorActionPreference = 'Stop'

function Write-Step($message) {
    Write-Host $message -ForegroundColor Cyan
}

function Get-ReleaseBase {
    if ($env:CORAMI_INSTALL_BASE) {
        return $env:CORAMI_INSTALL_BASE
    }

    if ($Version -eq 'latest') {
        return "https://github.com/$Repo/releases/latest/download"
    }

    return "https://github.com/$Repo/releases/download/$Version"
}

function Get-Architecture {
    switch ($env:PROCESSOR_ARCHITECTURE) {
        'AMD64' { return 'x64' }
        'ARM64' { return 'arm64' }
        default { throw "unsupported architecture: $env:PROCESSOR_ARCHITECTURE" }
    }
}

$base = Get-ReleaseBase
$asset = "corami-windows-$(Get-Architecture).exe"
$temporary = Join-Path $env:TEMP $asset

Write-Step "downloading $asset"
Invoke-WebRequest -Uri "$base/$asset" -OutFile $temporary

Write-Step "verifying the sha256 sum"
$checksumsFile = Join-Path $env:TEMP 'corami-checksums.txt'

try {
    Invoke-WebRequest -Uri "$base/checksums.txt" -OutFile $checksumsFile
} catch {
    throw "checksums.txt not available: $($_.Exception.Message)"
}

$expected = (Get-Content $checksumsFile | Where-Object { $_ -match " $([regex]::Escape($asset))$" } | ForEach-Object { ($_ -split '\s+')[0] })

if (-not $expected) {
    throw "$asset is not in checksums.txt"
}

$actual = (Get-FileHash -Algorithm SHA256 -Path $temporary).Hash.ToLower()

if ($actual -ne $expected.ToLower()) {
    throw "sha256 mismatch for $asset"
}

New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
$target = Join-Path $Prefix 'corami.exe'
Move-Item -Force $temporary $target
Write-Step "installed to $target"

$currentPath = [Environment]::GetEnvironmentVariable('Path', 'User')

if ($currentPath -notlike "*$Prefix*") {
    [Environment]::SetEnvironmentVariable('Path', "$currentPath;$Prefix", 'User')
    Write-Host "added $Prefix to the user PATH: reopen the terminal to use it" -ForegroundColor Yellow
}

if ($SkipSetup) {
    Write-Step 'setup skipped'
    return
}

if (-not $Client) {
    $Client = $Join
}

if ($Client) {
    & $target setup client $Client
    return
}

if (-not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected) {
    & $target setup client
    return
}

Write-Host ''
Write-Host 'Next step:' -ForegroundColor Green
Write-Host "  corami setup client <server>    to connect this client (open a new terminal first)"
