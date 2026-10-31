$ErrorActionPreference = 'Stop'
$fixtureRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'tests\fixtures'

& php (Join-Path $fixtureRoot 'php\tests\run.php')
if ($LASTEXITCODE -ne 0) { throw "PHP fixture failed with exit code $LASTEXITCODE" }

Push-Location (Join-Path $fixtureRoot 'python')
try {
    & python -m unittest -v
    if ($LASTEXITCODE -ne 0) { throw "Python fixture failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }

& npm --prefix (Join-Path $fixtureRoot 'javascript') test
if ($LASTEXITCODE -ne 0) { throw "JavaScript fixture failed with exit code $LASTEXITCODE" }

& dotnet run --project (Join-Path $fixtureRoot 'dotnet\MoonYa.DotNetFixture.csproj')
if ($LASTEXITCODE -ne 0) { throw ".NET fixture failed with exit code $LASTEXITCODE" }

Write-Output 'All language fixtures passed.'
