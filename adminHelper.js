// adminHelper.js - Handles admin-elevated operations for the Windows client
const { exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Track if we have admin rights
let hasAdminRights = false;

// Initialize and check admin rights
function initializeAdminRights() {
  if (process.platform !== 'win32') {
    return true; // Non-Windows platforms don't need this
  }
  
  try {
    // Try to write to a protected registry key as a test
    execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" /v ProductName', { stdio: 'ignore' });
    console.log('Admin rights confirmed!');
    hasAdminRights = true;
    return true;
  } catch (error) {
    console.log('No admin rights detected.');
    hasAdminRights = false;
    return false;
  }
}

// Check if we have admin rights
function hasElevated() {
  return hasAdminRights;
}

// Run a list of commands with admin privileges - completely hidden
function runElevated(commands) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(commands)) {
      commands = [commands];
    }
    
    // Create silent execution wrapper script
    const scriptContent = [
      '@echo off',
      'setlocal',
      'mode con cols=1 lines=1', // Minimize console if shown briefly
      ...commands,
      'exit' // Exit immediately when done
    ].join('\r\n');
    
    const tempScriptPath = path.join(process.env.TEMP || process.env.TMP || '.', `admin_script_${Date.now()}.bat`);
    fs.writeFileSync(tempScriptPath, scriptContent);
    
    // Use WindowStyle Hidden for both PowerShell and the cmd process
    const elevateProcess = exec(
      `powershell -WindowStyle Hidden -Command "Start-Process cmd -WindowStyle Hidden -Verb RunAs -ArgumentList '/c ${tempScriptPath}' -PassThru -Wait"`,
      { windowsHide: true }, // Hide the PowerShell window itself
      (error) => {
        // Clean up the temp file after execution
        setTimeout(() => {
          try {
            fs.unlinkSync(tempScriptPath);
          } catch (e) {
            console.log('Could not delete temp script file:', e.message);
          }
          
          if (error) {
            reject(error);
          } else {
            resolve(true);
          }
        }, 100); // Slightly longer timeout to ensure completion
      }
    );
  });
}

// Specific helper functions for privacy protections
async function applyPrivacyProtections() {
  // These commands are essential and must complete for the connection to be secure.
  const essentialCommands = [
    // === 1. CONFIGURE SYSTEM & WINHTTP PROXY ===
    'reg add "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "http://127.0.0.1:10809" /f',
    'reg add "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyOverride /t REG_SZ /d "<local>" /f',
    'reg add "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v AutoDetect /t REG_DWORD /d 0 /f',
    'reg add "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f',
    'netsh winhttp set proxy proxy-server="http=127.0.0.1:10809;https=127.0.0.1:10809;socks=127.0.0.1:10808" bypass-list="<local>"',

    // === 2. SILENT & INSTANT UI REFRESH via Windows API ===
    // This is the definitive, native method to tell Windows and all apps that proxy settings have changed.
    "powershell -NoProfile -ExecutionPolicy Bypass -Command \"Add-Type -MemberDefinition '[DllImport(\\\"wininet.dll\\\", SetLastError=true, CharSet=CharSet.Auto)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);' -Name W -Namespace N; [N.W]::InternetSetOption(0, 39, 0, 0); [N.W]::InternetSetOption(0, 37, 0, 0);\"",
    
    // === 3. FLUSH DNS CACHE ===
    'ipconfig /flushdns'
  ];

  // These commands can run in the background without delaying the connection.
  const backgroundCommands = [
    // === BROWSER & SYSTEM POLICIES (run in background) ===
    'reg add "HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Google\\Chrome" /v WebRtcIPHandling /t REG_SZ /d disable_non_proxied_udp /f',
    'reg add "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome" /v WebRtcIPHandling /t REG_SZ /d disable_non_proxied_udp /f',
    'reg add "HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Google\\Chrome" /v DnsOverHttpsMode /t REG_SZ /d off /f',
    'reg add "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome" /v DnsOverHttpsMode /t REG_SZ /d off /f',
    'reg add "HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Google\\Chrome" /v ProxyMode /t REG_SZ /d system /f',
    'reg add "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome" /v ProxyMode /t REG_SZ /d system /f',
    'reg add "HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Microsoft\\Edge" /v WebRtcIPHandling /t REG_SZ /d disable_non_proxied_udp /f',
    'reg add "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Edge" /v WebRtcIPHandling /t REG_SZ /d disable_non_proxied_udp /f',
    'reg add "HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Microsoft\\Edge" /v DnsOverHttpsMode /t REG_SZ /d off /f',
    'reg add "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Edge" /v DnsOverHttpsMode /t REG_SZ /d off /f',
    'reg add "HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Microsoft\\Edge" /v ProxyMode /t REG_SZ /d system /f',
    'reg add "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Edge" /v ProxyMode /t REG_SZ /d system /f',
    'gpupdate' // Removed /force flag to run quickly in the background
  ];

  // Run essential commands first and wait for them.
  await runElevated(essentialCommands);
  
  // Run non-essential commands in the background.
  runElevated(backgroundCommands).catch(err => {
    console.error('An error occurred while applying background privacy settings:', err);
  });

  return true;
}

// Remove privacy protections
async function removePrivacyProtections() {
  // Essential commands that must run for a clean and fast disconnect.
  const essentialCommands = [
    // === 1. DISABLE SYSTEM PROXY & RESET WINHTTP ===
    'reg add "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f',
    'netsh winhttp reset proxy',

    // === 2. SILENT & INSTANT UI REFRESH via Windows API ===
    "powershell -NoProfile -ExecutionPolicy Bypass -Command \"Add-Type -MemberDefinition '[DllImport(\\\"wininet.dll\\\", SetLastError=true, CharSet=CharSet.Auto)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);' -Name W -Namespace N; [N.W]::InternetSetOption(0, 39, 0, 0); [N.W]::InternetSetOption(0, 37, 0, 0);\"",
    
    // === 3. FLUSH DNS CACHE ===
    'ipconfig /flushdns'
  ];

  // Background commands for cleanup and policy reset.
  const backgroundCommands = [
    // === CLEANUP PROXY & BROWSER POLICIES (run in background) ===
    'reg delete "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /f',
    'reg delete "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyOverride /f',
    'reg delete "HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Google\\Chrome" /v WebRtcIPHandling /f',
    'reg delete "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome" /v WebRtcIPHandling /f',
    'reg delete "HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Google\\Chrome" /v DnsOverHttpsMode /f',
    'reg delete "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome" /v DnsOverHttpsMode /f',
    'reg delete "HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Google\\Chrome" /v ProxyMode /f',
    'reg delete "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome" /v ProxyMode /f',
    'reg delete "HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Microsoft\\Edge" /v WebRtcIPHandling /f',
    'reg delete "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Edge" /v WebRtcIPHandling /f',
    'reg delete "HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Microsoft\\Edge" /v DnsOverHttpsMode /f',
    'reg delete "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Edge" /v DnsOverHttpsMode /f',
    'reg delete "HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Microsoft\\Edge" /v ProxyMode /f',
    'reg delete "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Edge" /v ProxyMode /f',
    'gpupdate'
  ];

  // Run essential commands first and wait for them.
  await runElevated(essentialCommands);

  // Run cleanup commands in the background.
  runElevated(backgroundCommands).catch(err => {
    console.error('An error occurred while removing background privacy settings:', err);
  });

  return true;
}

// Export all the functions needed by main.js
module.exports = {
  applyPrivacyProtections,
  removePrivacyProtections,
  runElevated,
  initializeAdminRights,
  hasElevated
};
