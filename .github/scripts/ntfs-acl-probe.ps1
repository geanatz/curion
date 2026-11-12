# Temporary, synthetic-only NTFS ACL diagnostic for Curion PR #7.
# No production files, accounts or customer data are accessed.
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$probeRoot = Join-Path $env:RUNNER_TEMP ("curion-ntfs-probe-" + [guid]::NewGuid().ToString("N"))
$ordinary = Join-Path $probeRoot "ordinary"
$shared = Join-Path $probeRoot "shared"
$targets = @(".curion", ".curion/curion.sqlite", ".curion/trace.sqlite", ".curion/config.json")
$everyoneSid = "S-1-1-0"
$broadReadSids = @($everyoneSid, "S-1-5-11", "S-1-5-32-545")
$readDataBit = [int][System.Security.AccessControl.FileSystemRights]::ReadData
$allow = [System.Security.AccessControl.AccessControlType]::Allow

function Get-BroadReadGrants([string]$target) {
  $acl = Get-Acl -LiteralPath $target
  $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
  $findings = @()
  foreach ($rule in $rules) {
    $sid = $rule.IdentityReference.Value
    $rights = [int]$rule.FileSystemRights
    if (($broadReadSids -contains $sid) -and
        $rule.AccessControlType -eq $allow -and
        ($rights -band $readDataBit) -ne 0) {
      $findings += [pscustomobject]@{
        Sid = $sid
        Inherited = $rule.IsInherited
        Rights = $rule.FileSystemRights.ToString()
      }
    }
  }
  return @($findings)
}

$createNode = @'
import { initStorage, closeStorage } from "./dist/storage/storage.js";
import { initTraceStorage, closeTraceStorage } from "./dist/trace/trace-storage.js";
import { writeProjectConfig } from "./dist/config/project-config.js";
const root = process.argv[1];
if (!root) throw new Error("missing synthetic root");
const memory = initStorage({ projectRoot: root });
try {
  memory.db.prepare("INSERT OR REPLACE INTO _meta (key,value) VALUES (?,?)").run("ntfs-synthetic", "1");
} finally {
  closeStorage(memory);
}
const trace = initTraceStorage({ projectRoot: root });
try {
  trace.db.prepare("INSERT OR REPLACE INTO _meta (key,value) VALUES (?,?)").run("ntfs-synthetic", "1");
} finally {
  closeTraceStorage(trace);
}
writeProjectConfig(root, { version: 1, isPrivate: true });
'@

try {
  New-Item -ItemType Directory -Path $ordinary, $shared -Force | Out-Null
  & icacls.exe $shared /grant '*S-1-1-0:(OI)(CI)(R)' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Unable to create the synthetic shared-directory control" }

  $controlGrants = @(Get-BroadReadGrants $shared)
  if (@($controlGrants | Where-Object { $_.Sid -eq $everyoneSid }).Count -lt 1) {
    throw "Invalid synthetic control: Everyone read was not granted on shared root"
  }
  Write-Output "NTFS_CONTROL=VALID (explicit Everyone inherited read granted on synthetic shared parent)"

  $sharedExposures = @()
  foreach ($scenario in @(
    @{ Label = "ordinary"; Root = $ordinary },
    @{ Label = "shared"; Root = $shared }
  )) {
    & node --input-type=module -e $createNode $scenario.Root
    if ($LASTEXITCODE -ne 0) { throw "Synthetic Curion initialization failed" }

    foreach ($relative in $targets) {
      $path = Join-Path $scenario.Root ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)
      if (-not (Test-Path -LiteralPath $path)) { throw "Expected synthetic file missing: $relative" }
      $grants = @(Get-BroadReadGrants $path)
      if ($grants.Count -eq 0) {
        Write-Output "NTFS_ACL scenario=$($scenario.Label) target=$relative broad_read_allow=none"
      } else {
        foreach ($grant in $grants) {
          Write-Output "NTFS_ACL scenario=$($scenario.Label) target=$relative broad_read_allow=$($grant.Sid) inherited=$($grant.Inherited) rights=$($grant.Rights)"
        }
        if ($scenario.Label -eq "shared" -and $relative -ne ".curion") {
          $sharedExposures += $relative
        }
      }
    }
  }

  if ($sharedExposures.Count -gt 0) {
    Write-Output "NTFS_RESULT=SHARED_PARENT_BROAD_READ_INHERITED"
    Write-Output "::warning::Curion-generated synthetic files inherited broad read grants from a permissive Windows parent. This shows a DACL hardening gap, not a demonstrated cross-account read."
  } else {
    Write-Output "NTFS_RESULT=NO_BROAD_READ_GRANTS_OBSERVED"
  }
  # Diagnostics should complete to preserve evidence. Review must interpret
  # the results; a green job does NOT imply Windows ACLs are safe.
} finally {
  if (Test-Path -LiteralPath $probeRoot) {
    Remove-Item -LiteralPath $probeRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
