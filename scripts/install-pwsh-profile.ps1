# Install UTF-8 defaults into the current user's PowerShell profile (idempotent, backs up once).
$ErrorActionPreference = 'Stop'
$profilePath = $PROFILE.CurrentUserAllHosts
$marker = '# >>> dsh-finance utf8 defaults >>>'
$block = @'

# >>> dsh-finance utf8 defaults >>>
try {
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  [Console]::InputEncoding = $utf8
  [Console]::OutputEncoding = $utf8
  $OutputEncoding = $utf8
  $PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'
  $PSDefaultParameterValues['Set-Content:Encoding'] = 'utf8'
  $PSDefaultParameterValues['Add-Content:Encoding'] = 'utf8'
} catch { }
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'
# <<< dsh-finance utf8 defaults <<<
'@

$dir = Split-Path -Parent $profilePath
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$existing = if (Test-Path -LiteralPath $profilePath) { Get-Content -LiteralPath $profilePath -Raw } else { '' }
if ($existing -match [regex]::Escape($marker)) {
  Write-Output "profile already configured: $profilePath"
  exit 0
}
if ($existing) {
  $backup = "$profilePath.bak-$(Get-Date -Format yyyyMMddHHmmss)"
  Copy-Item -LiteralPath $profilePath -Destination $backup
  Write-Output "backup: $backup"
}
[System.IO.File]::WriteAllText($profilePath, ($existing + $block), [System.Text.UTF8Encoding]::new($false))
Write-Output "configured: $profilePath"
Write-Output "Open a new terminal (or run '. `$PROFILE') to apply."
