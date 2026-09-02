$ErrorActionPreference = "Stop"

$projectDir = $PSScriptRoot
$env:UV_CACHE_DIR = Join-Path $projectDir ".uv-cache"

Push-Location $projectDir
try {
    uv sync --locked
    uv run python download_toi270.py
    uv run python download_l98_59.py
    uv run python download_cm_dra.py
    uv run streamlit run semi_auto_bls.py
}
finally {
    Pop-Location
}
