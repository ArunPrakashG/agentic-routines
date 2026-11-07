# Installs Agentic Routines for this user: irm https://agenticroutines.arunprakashg.com/install.ps1 | iex
#
# For a particular version, or to leave your agents alone, set these first:
#   $env:AGENTIC_ROUTINES_VERSION = '1.2.3'
#   $env:AGENTIC_ROUTINES_NO_SETUP = '1'
#
# Everything goes in %USERPROFILE%\.agentic-routines\app. Nothing needs an administrator.
# To remove it: agentic-routines setup --remove, then delete that folder and take it off your Path.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Install-AgenticRoutines {
  if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
    throw "There is no build for a $($env:PROCESSOR_ARCHITECTURE) processor. Try: npx agentic-routines setup"
  }
  if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) {
    throw 'This needs tar.exe, which comes with Windows 10 and later.'
  }

  $want = $env:AGENTIC_ROUTINES_VERSION
  if ($want -and $want -notmatch '^\d+\.\d+\.\d+[\w.-]*$') { throw "$want is not a version." }
  $site = 'https://github.com/ArunPrakashG/agentic-routines/releases'
  $base = $env:AGENTIC_ROUTINES_BASE
  if (-not $base) { $base = if ($want) { "$site/download/v$want" } else { "$site/latest/download" } }

  $homeDir = if ($env:AGENTIC_ROUTINES_HOME) { $env:AGENTIC_ROUTINES_HOME } else { Join-Path $env:USERPROFILE '.agentic-routines' }
  # The project had another name once, and the CLI only moves the old folder when there is no new one yet.
  $old = Join-Path $env:USERPROFILE '.browser-routines'
  if (-not $env:AGENTIC_ROUTINES_HOME -and (Test-Path $old) -and -not (Test-Path $homeDir)) { Move-Item $old $homeDir }
  $app = Join-Path $homeDir 'app'
  New-Item -ItemType Directory -Force -Path $app | Out-Null
  $work = Join-Path $app ".install.$PID"
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  try {
    $manifestFile = Join-Path $work 'manifest.json'
    Invoke-WebRequest -UseBasicParsing -Uri "$base/manifest.json" -OutFile $manifestFile
    $manifest = Get-Content -Raw $manifestFile | ConvertFrom-Json
    $version = $manifest.version
    $file = $manifest.files.'win-x64'
    if ($version -notmatch '^\d+\.\d+\.\d+[\w.-]*$') { throw 'The manifest names an odd version.' }
    if (-not $file) { throw "Version $version has nothing for Windows." }
    if ($file.name -notmatch '^[\w.-]+$' -or $file.name -match '\.\.') { throw 'The manifest names an odd file.' }

    Write-Host "Downloading Agentic Routines $version for Windows."
    $archive = Join-Path $work $file.name
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$($file.name)" -OutFile $archive
    if ((Get-Item $archive).Length -ne $file.size) { throw 'The download is the wrong size, so nothing was installed.' }
    if ((Get-FileHash -Algorithm SHA256 $archive).Hash.ToLower() -ne $file.sha256) { throw 'The download does not match its checksum, so nothing was installed.' }

    $new = Join-Path $work 'new'
    New-Item -ItemType Directory -Force -Path $new | Out-Null
    & tar.exe -xzf $archive -C $new
    if ($LASTEXITCODE -ne 0) { throw 'The download could not be unpacked, so nothing was installed.' }
    & (Join-Path $new 'node.exe') (Join-Path $new 'node_modules\agentic-routines\dist\index.js') help *> $null
    if ($LASTEXITCODE -ne 0) { throw 'The download does not run on this machine, so nothing was installed.' }

    $currentFile = Join-Path $app 'current.txt'
    $before = if (Test-Path $currentFile) { (Get-Content -Raw $currentFile).Trim() } else { '' }
    $dest = Join-Path $app $version
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    Move-Item $new $dest

    # The one command everything points at. It reads the version each time, so an update takes effect by changing one file.
    $run = "@echo off`r`nsetlocal`r`nset /p version=<`"%~dp0current.txt`"`r`n`"%~dp0%version%\node.exe`" `"%~dp0%version%\node_modules\agentic-routines\dist\index.js`" %*`r`n"
    [IO.File]::WriteAllText((Join-Path $app 'run.cmd'), $run, (New-Object Text.ASCIIEncoding))
    [IO.File]::WriteAllText($currentFile, $version, (New-Object Text.ASCIIEncoding))

    Get-ChildItem -Directory $app | Where-Object { $_.Name -match '^\d' -and $_.Name -ne $version -and $_.Name -ne $before } | Remove-Item -Recurse -Force

    $bin = Join-Path $env:LOCALAPPDATA 'Programs\agentic-routines'
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    [IO.File]::WriteAllText((Join-Path $bin 'agentic-routines.cmd'), "@echo off`r`ncall `"$app\run.cmd`" %*`r`n", (New-Object Text.ASCIIEncoding))
    $path = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (($path -split ';') -contains $bin)) {
      [Environment]::SetEnvironmentVariable('Path', "$(if ($path) { "$path;" })$bin", 'User')
      $env:Path = "$env:Path;$bin"
      Write-Host "Added $bin to your Path. Open a new terminal for it to take effect elsewhere."
    }

    Write-Host "Installed $version`: $bin\agentic-routines.cmd"
    if ($env:AGENTIC_ROUTINES_NO_SETUP -ne '1' -and [Environment]::UserInteractive) {
      & (Join-Path $bin 'agentic-routines.cmd') setup
    } else {
      Write-Host 'Then connect your agents: agentic-routines setup'
    }
  } finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  }
}

Install-AgenticRoutines
