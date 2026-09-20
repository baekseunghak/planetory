[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0, ValueFromPipeline)]
    [ValidateNotNullOrEmpty()]
    [string]$Message,

    [string]$Channel,

    [string]$EnvFile = (Join-Path (Split-Path $PSScriptRoot -Parent) '.env'),

    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-DotEnvValue {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [string]$Name
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }

    $prefix = '^\s*' + [regex]::Escape($Name) + '\s*=\s*(.*?)\s*$'
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match $prefix) {
            return $Matches[1].Trim('"', "'")
        }
    }

    return $null
}

$webhookUrl = $env:MATTERMOST_WEBHOOK_URL
if ([string]::IsNullOrWhiteSpace($webhookUrl)) {
    $webhookUrl = Get-DotEnvValue -Path $EnvFile -Name 'MATTERMOST_WEBHOOK_URL'
}

if (-not $PSBoundParameters.ContainsKey('Channel')) {
    $Channel = $env:MATTERMOST_CHANNEL
    if ([string]::IsNullOrWhiteSpace($Channel)) {
        $Channel = Get-DotEnvValue -Path $EnvFile -Name 'MATTERMOST_CHANNEL'
    }
}

$payload = [ordered]@{ text = $Message }
if (-not [string]::IsNullOrWhiteSpace($Channel)) {
    $payload.channel = $Channel
}
$json = $payload | ConvertTo-Json -Compress

if ($DryRun) {
    $json
    return
}

if ([string]::IsNullOrWhiteSpace($webhookUrl)) {
    throw "MATTERMOST_WEBHOOK_URL이 없습니다. '$EnvFile' 또는 현재 프로세스 환경 변수에 설정하세요."
}

$uri = $null
if (-not [uri]::TryCreate($webhookUrl, [UriKind]::Absolute, [ref]$uri) -or
    $uri.Scheme -notin @('http', 'https')) {
    throw 'MATTERMOST_WEBHOOK_URL은 http 또는 https 절대 URL이어야 합니다.'
}

$body = [Text.Encoding]::UTF8.GetBytes($json)
Invoke-RestMethod -Method Post -Uri $uri -ContentType 'application/json; charset=utf-8' -Body $body | Out-Null
Write-Output 'PASS: Mattermost message sent.'
