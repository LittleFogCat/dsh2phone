# DSH LAN diagnostic - run elevated (UAC), writes results next to this script
# (the .out.txt dump is git-ignored: it contains local IPs and process details).
$out = Join-Path $PSScriptRoot "diag-firewall.out.txt"
Remove-Item $out -ErrorAction SilentlyContinue
$lines = @()
$lines += "=== collected at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="

$lines += "`n--- active network profile(s) ---"
$lines += (netsh advfirewall monitor show currentprofile) 2>&1 | Out-String

$lines += "--- all firewall profiles state ---"
$lines += (netsh advfirewall show allprofiles) | Out-String

$lines += "--- inbound rules matching 2622 / DSH ---"
$rules = Get-NetFirewallRule -Direction Inbound -ErrorAction SilentlyContinue | Where-Object {
    ($_.DisplayName -match 'DSH|dsh') -or
    (($_ | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue).LocalPort -contains '2622')
}
if ($rules) {
    foreach ($r in $rules) {
        $pf = $r | Get-NetFirewallPortFilter
        $lines += "[$($r.Enabled)/$($r.Action)/profile=$($r.Profile)] $($r.DisplayName) proto=$($pf.Protocol) port=$($pf.LocalPort)"
    }
} else { $lines += "(no matching inbound rules found)" }

$lines += "`n--- ICMP echo rule state ---"
$icmp = Get-NetFirewallRule -DisplayName "File and Printer Sharing (Echo Request - ICMPv4-In)" -ErrorAction SilentlyContinue
foreach ($r in $icmp) { $lines += "[$($r.Enabled)/$($r.Action)/profile=$($r.Profile)] $($r.DisplayName)" }

$lines += "`n--- enabling ICMP echo for all profiles (for phone ping test) ---"
try {
    Set-NetFirewallRule -DisplayName "File and Printer Sharing (Echo Request - ICMPv4-In)" -Enabled True -Profile Any -ErrorAction Stop
    $lines += "ICMP echo inbound: ENABLED ok"
} catch { $lines += "ICMP echo enable failed: $($_.Exception.Message)" }

$lines += "`n--- network connections & category ---"
Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object { $lines += "iface=$($_.InterfaceAlias) network=$($_.Name) category=$($_.NetworkCategory) ipv4=$($_.IPv4Connectivity)" }

$lines += "`n--- listening on 2622 ---"
$lines += (netstat -ano | findstr "2622") | Out-String

$lines += "--- third-party AV/firewall (SecurityCenter2) ---"
try {
    Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop | ForEach-Object { $lines += "AV: $($_.displayName)" }
    Get-CimInstance -Namespace root/SecurityCenter2 -ClassName FirewallProduct -ErrorAction Stop | ForEach-Object { $lines += "FW: $($_.displayName)" }
} catch { $lines += "SecurityCenter2 query failed: $($_.Exception.Message)" }

$lines | Out-File -FilePath $out -Encoding UTF8
Write-Host "done -> $out"
