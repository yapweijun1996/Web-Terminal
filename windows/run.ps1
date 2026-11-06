param(
    [Parameter(Mandatory = $true)][string]$CloudflaredPath
)
$ErrorActionPreference = 'Stop'
$configPath = Join-Path $PSScriptRoot 'deployment.local.json'
$tunnelPath = Join-Path $PSScriptRoot 'cloudflared.local.yml'
if (-not (Test-Path -LiteralPath $configPath) -or -not (Test-Path -LiteralPath $tunnelPath)) {
    throw 'Verified local deployment and tunnel configurations are required.'
}
if (-not (Test-Path -LiteralPath $CloudflaredPath -PathType Leaf)) { throw 'Cloudflared executable not found.' }
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
& $nodePath --input-type=module -e "import fs from 'node:fs'; import {pathToFileURL} from 'node:url'; const {validateConfig}=await import(pathToFileURL(process.argv[2])); validateConfig(JSON.parse(fs.readFileSync(process.argv[1], 'utf8')));" $configPath (Join-Path $PSScriptRoot 'access.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Invalid terminal configuration.' }
$tunnelText = Get-Content -LiteralPath $tunnelPath -Raw
if ($tunnelText -match 'REPLACE_' -or $tunnelText -notmatch 'required:\s*true') { throw 'Access-protected tunnel configuration required.' }
& $CloudflaredPath tunnel --config $tunnelPath ingress validate
if ($LASTEXITCODE -ne 0) { throw 'Invalid tunnel configuration.' }
# Terminal process and existing sessions are never restarted automatically.
# A connector restart can reconnect browsers without replacing their shells.
$terminal = $null
$tunnel = $null
try {
    $terminal = Start-Process -FilePath $nodePath -ArgumentList @(('"' + (Join-Path $PSScriptRoot 'server.mjs') + '"')) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 2
    if ($terminal.HasExited) { throw 'Terminal listener failed. Existing listeners were not stopped.' }
    $deployment = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $deployment.port -State Listen -ErrorAction Stop
    if ($listener.OwningProcess -ne $terminal.Id) { throw 'Terminal listener ownership mismatch.' }
    while (-not $terminal.HasExited) {
        $tunnel = Start-Process -FilePath $CloudflaredPath -ArgumentList @('tunnel', '--config', ('"' + $tunnelPath + '"'), 'run') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
        while (-not $terminal.HasExited -and -not $tunnel.HasExited) { Start-Sleep -Seconds 2 }
        if (-not $terminal.HasExited) { Start-Sleep -Seconds 10 }
    }
} finally {
    if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue }
    if ($terminal -and -not $terminal.HasExited) { Stop-Process -Id $terminal.Id -ErrorAction SilentlyContinue }
}
