<#
.SYNOPSIS
    Mirrors the latest AShot release from GitHub into a folder served by IIS.

.DESCRIPTION
    AShot builds made with the GitHub secret UPDATE_URL read <UPDATE_URL>/latest.json.
    Run every few minutes by Task Scheduler, this script downloads the files of a new
    release, checks their size and SHA-256 against the release manifest and publishes
    latest.json last, so clients never see a manifest whose files are missing.
    Only the newest versions are kept. Works with Windows PowerShell 5.1 and PowerShell 7.

.PARAMETER Target
    Folder of the IIS site or virtual directory, e.g. C:\inetpub\updates\ashot.

.PARAMETER Repo
    GitHub repository (owner/name).

.PARAMETER Token
    GitHub token with read-only access to the repository contents. Needed only for a
    private repository; by default taken from the ASHOT_GITHUB_TOKEN environment variable.

.PARAMETER Keep
    How many versions to keep in the folder.

.PARAMETER ApiBase
    GitHub API address (GitHub Enterprise has its own).

.EXAMPLE
    .\Sync-AShotUpdates.ps1 -Target C:\inetpub\updates\ashot
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $Target,
    [string] $Repo = 'JeyDim/AShot',
    [string] $Token = $env:ASHOT_GITHUB_TOKEN,
    [int] $Keep = 3,
    [string] $ApiBase = 'https://api.github.com'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # the progress bar makes Invoke-WebRequest very slow
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$log = Join-Path $PSScriptRoot 'Sync-AShotUpdates.log'
function Write-Log([string] $Text) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $Text" | Add-Content -Path $log -Encoding UTF8
}

# JSON without a BOM (Windows PowerShell's UTF8 adds one, and clients would reject it).
function Write-Json($Object, [string] $Path) {
    $json = $Object | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText($Path, $json, (New-Object Text.UTF8Encoding $false))
}

$headers = @{ 'User-Agent' = 'AShot-update-mirror'; 'Accept' = 'application/vnd.github+json' }
if ($Token) { $headers['Authorization'] = "Bearer $Token" }

function Save-Asset($Asset, [string] $Path) {
    if ($Token) {
        # Private repository: the API link with the token (the redirect drops it again).
        $h = $headers.Clone()
        $h['Accept'] = 'application/octet-stream'
        Invoke-WebRequest -Uri $Asset.url -Headers $h -OutFile $Path -UseBasicParsing
    } else {
        Invoke-WebRequest -Uri $Asset.browser_download_url -Headers @{ 'User-Agent' = 'AShot-update-mirror' } -OutFile $Path -UseBasicParsing
    }
}

$work = $null
try {
    New-Item -ItemType Directory -Force -Path $Target | Out-Null
    $release = Invoke-RestMethod -Uri "$ApiBase/repos/$Repo/releases/latest" -Headers $headers
    $manifestAsset = $release.assets | Where-Object { $_.name -eq 'latest.json' } | Select-Object -First 1
    if (-not $manifestAsset) {
        Write-Log "$($release.tag_name): the release has no latest.json, skipped"
        return
    }

    $work = Join-Path ([IO.Path]::GetTempPath()) "ashot-mirror-$PID"
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    Save-Asset $manifestAsset (Join-Path $work 'latest.json')
    $manifest = Get-Content -Raw -Encoding UTF8 (Join-Path $work 'latest.json') | ConvertFrom-Json

    $current = Join-Path $Target 'latest.json'
    if ((Test-Path $current) -and ((Get-Content -Raw -Encoding UTF8 $current | ConvertFrom-Json).version -eq $manifest.version)) {
        return # nothing new
    }

    # Files of each platform; `files` is the old name of `win_amd64` (the same files),
    # still read by versions before the ARM64 builds.
    $saved = @{}
    foreach ($platform in 'win_amd64', 'win_arm64', 'files') {
        $files = $manifest.$platform
        if (-not $files) { continue }
        foreach ($kind in 'installer', 'portable') {
            $entry = $files.$kind
            if (-not $entry) { continue }
            $name = [IO.Path]::GetFileName(([Uri] $entry.url).AbsolutePath)
            if (-not $saved.ContainsKey($name)) {
                $asset = $release.assets | Where-Object { $_.name -eq $name } | Select-Object -First 1
                if (-not $asset) { throw "$name is listed in latest.json but missing in release $($release.tag_name)" }
                $file = Join-Path $work $name
                Save-Asset $asset $file
                $hash = (Get-FileHash -Algorithm SHA256 -Path $file).Hash
                if ((Get-Item $file).Length -ne $entry.size -or $hash -ne $entry.sha256) {
                    throw "${name}: size or SHA-256 differs from latest.json"
                }
                Move-Item -Force -Path $file -Destination (Join-Path $Target $name)
                $saved[$name] = $true
            }
            $entry.url = $name # relative: clients download it from this folder
        }
    }
    # The release page of a private repository is not reachable for users; the app then
    # shows the notes from the manifest instead of a "what's new" link.
    if ($Token) { $manifest.url = '' }

    # The manifest goes last and is replaced in one step.
    $next = Join-Path $work 'latest.json.next'
    Write-Json $manifest $next
    Move-Item -Force -Path $next -Destination $current
    Write-Log "published $($manifest.version)"

    # Keep the files of the newest versions only.
    $versions = Get-ChildItem -Path $Target -File -Filter 'AShot_*' |
        ForEach-Object { if ($_.Name -match '^AShot_(\d+\.\d+\.\d+)_') { [version] $Matches[1] } } |
        Sort-Object -Unique -Descending
    foreach ($old in ($versions | Select-Object -Skip $Keep)) {
        Get-ChildItem -Path $Target -File -Filter "AShot_$($old)_*" | Remove-Item -Force
        Write-Log "removed $old"
    }
} catch {
    Write-Log "error: $($_.Exception.Message)"
    throw
} finally {
    if ($work -and (Test-Path $work)) { Remove-Item -Recurse -Force -Path $work }
}
