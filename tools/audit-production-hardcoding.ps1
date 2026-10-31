[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$sourceRoots = @(
    (Join-Path $workspaceRoot 'MoonYa-Backend'),
    (Join-Path $workspaceRoot 'MoonYa-Python'),
    (Join-Path $workspaceRoot 'MoonYa-Win\MoonYa-Solution\MoonYa')
)
$sourceExtensions = @('.php', '.js', '.py', '.cs')

function Get-WorkspaceRelativePath([string]$fullPath) {
    $resolved = [IO.Path]::GetFullPath($fullPath)
    if (-not $resolved.StartsWith($workspaceRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the workspace: $resolved"
    }
    return $resolved.Substring($workspaceRoot.Length).TrimStart('\', '/').Replace('\', '/')
}

function Test-ProductionSource([System.IO.FileInfo]$file) {
    if ($sourceExtensions -notcontains $file.Extension.ToLowerInvariant()) { return $false }
    $relative = Get-WorkspaceRelativePath $file.FullName
    if ($relative -match '(?i)(^|/)(vendor|node_modules|\.venv|bin|obj|logs?|tests?|packages|resources|__pycache__|crawler_output|python|uploads?|downloads?|cache)(/|$)') { return $false }
    if ($file.Name -match '(?i)(\.min\.js$|^test_|_test|smoke|debug|diagnose|^check_|^migrate|^tmp)') { return $false }
    if ($file.Name -in @('config.php', 'agent_config.php', 'https_server.php')) { return $false }
    return $true
}

function Get-LineNumber([string]$text, [int]$index) {
    if ($index -le 0) { return 1 }
    return ([regex]::Matches($text.Substring(0, $index), "`n").Count + 1)
}

$files = foreach ($root in $sourceRoots) {
    if (Test-Path -LiteralPath $root) {
        Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object { Test-ProductionSource $_ }
    }
}

$violations = [System.Collections.Generic.List[object]]::new()
function Add-Matches([System.IO.FileInfo]$file, [string]$text, [string]$rule, [string]$pattern) {
    foreach ($match in [regex]::Matches($text, $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
        $violations.Add([pscustomobject]@{
            Rule = $rule
            File = Get-WorkspaceRelativePath $file.FullName
            Line = Get-LineNumber $text $match.Index
            Match = $match.Value
        })
    }
}

foreach ($file in $files) {
    $text = [IO.File]::ReadAllText($file.FullName)
    Add-Matches $file $text 'windows_absolute_path' '(?<![A-Za-z])[A-Z]:[\/]'
    Add-Matches $file $text 'fixed_loopback_port' '(?:127\.0\.0\.1|localhost):\d+'
    Add-Matches $file $text 'site_specialization' '宝塔|\.btlink|\.bt-form|\.bt-modal|\.bt-popup'
    Add-Matches $file $text 'model_literal' '(?:deepseek|moonshot|kimi|minimax|glm|gpt|claude)[-_]?(?:v?\d|latest|flash|pro|preview|turbo)[A-Za-z0-9._-]*'
    Add-Matches $file $text 'model_name_inference' '(?:strpos|stripos)\([^\r\n]*(?:deepseek|moonshot|kimi|minimax|glm|gpt|claude)'

    foreach ($match in [regex]::Matches($text, 'https?://[A-Za-z0-9][A-Za-z0-9.-]*', [Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
        $externalHost = $match.Value -replace '^https?://', ''
        if ($externalHost -in @('www.w3.org', 'host', 'localhost', '127.0.0.1', 'example.com', 'www.example.com', 'your-domain.com')) {
            continue
        }
        $violations.Add([pscustomobject]@{
            Rule = 'external_url_literal'
            File = Get-WorkspaceRelativePath $file.FullName
            Line = Get-LineNumber $text $match.Index
            Match = $match.Value
        })
    }

    $relative = Get-WorkspaceRelativePath $file.FullName
    $isBrowserContract = $relative.EndsWith('/Services/BrowserAutomationGateway.php') -or
        $relative.EndsWith('/Services/BrowserProtocol.cs')
    if (-not $isBrowserContract) {
        Add-Matches $file $text 'browser_route_outside_contract' '/browser/(?:execute|authorize|start|status|stop|navigate|back|forward|reload|inspect|screenshot|click|fill|hover|press|select|check|uncheck|scroll|wait|new-tab|list-tabs|switch-tab|close-tab|list-downloads|get-elements)'
    }
}

$browserEngineFiles = $files | Where-Object {
    $_.Name -in @(
        'BrowserAutomationService.cs',
        'BrowserApiServer.cs',
        'BrowserSecurityGate.cs',
        'BrowserProtocol.cs',
        'BrowserAutomationGateway.php'
    )
}
foreach ($file in $browserEngineFiles) {
    $text = [IO.File]::ReadAllText($file.FullName)
    Add-Matches $file $text 'framework_selector_in_browser_engine' '\.(?:layui[-_]|ant-(?:btn|modal|form|input|select)|el-(?:button|dialog|form|input|select)|modal-dialog|btn-primary)'
}

if ($violations.Count -gt 0) {
    $violations | Sort-Object File, Line, Rule | Format-Table Rule, File, Line, Match -AutoSize | Out-String | Write-Error
    exit 1
}

Write-Output "production hardcoding audit OK ($($files.Count) source files)"
