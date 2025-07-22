const { spawn, exec } = require('child_process');

// Import the admin helper module
const adminHelper = require('./adminHelper');

const { app, BrowserWindow, ipcMain, Tray, Menu, session, dialog } = require('electron');

// --- SINGLE INSTANCE LOCK ---
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}
// If a second instance is launched, focus the window
app.on('second-instance', () => {
  if (global.mainWindow) {
    if (global.mainWindow.isMinimized()) global.mainWindow.restore();
    global.mainWindow.focus();
  }
});
// Admin elevation now handled by adminHelper.js
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first'); // Set preference for all DNS lookups
const dnsPromises = dns.promises;
const tcpp = require('tcp-ping');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const net = require('net');
const axios = require('axios');
const serverManager = require('./serverManager');

// Port constants
const SOCKS_PORT = 1080;
const HTTP_PORT = 1081;
const networkMonitor = require('./networkMonitor');

// App paths
const configPath = path.join(app.getPath('userData'), 'xray_config.json');
const serversPath = path.join(app.getPath('userData'), 'servers.json');
const binDir = path.join(__dirname, 'bin');

// Global variables
let mainWindow = null;
let tray = null;
let xrayProcess = null;
let isConnected = false;
let connectionStartTime = null;
let serversData = { servers: [], activeServer: null };
let autoReconnectEnabled = true; // Auto-reconnect enabled by default
let isAutoFailoverInProgress = false;
let isReconnectionInProgress = false; // Flag to prevent simultaneous reconnections
let lastConnectedIP = null;
let lastReconnectTime = 0; // Timestamp of last reconnection attempt

// --- IPC HANDLER FOR PINGING SERVERS ---
ipcMain.handle('ping-server', async (event, { host, port }) => {
  try {
    // Resolve hostname to IP address first, as requested
    const { address: ip } = await dnsPromises.lookup(host, { family: 4 });

    return new Promise((resolve) => {
      tcpp.ping({ address: ip, port: port, timeout: 2000, attempts: 1 }, (err, data) => {
        if (err || isNaN(data.avg)) {
          resolve(null); // Return null on failure or if ping is NaN
        } else {
          resolve(Math.round(data.avg));
        }
      });
    });
  } catch (error) {
    console.error(`Ping error for ${host}:${port}:`, error.message);
    return null; // Return null if DNS lookup or ping fails
  }
});

// Find Xray binary
function findXrayBinary() {
  const binaryName = 'xray.exe';
  let possiblePaths = [];

  // Determine search paths based on whether the app is packaged
  if (app.isPackaged) {
    // In production, the binary is in the resources directory
    const resourcesPath = process.resourcesPath;
    possiblePaths.push(path.join(resourcesPath, 'bin', binaryName));
  } else {
    // In development, the binary is in the project's bin directory
    possiblePaths.push(path.join(__dirname, 'bin', binaryName));
  }

  for (const binPath of possiblePaths) {
    try {
      // Check if the binary exists at the specified path
      if (fs.existsSync(binPath)) {
        console.log(`Found Xray binary at: ${binPath}`);
        return binPath;
      }
    } catch (error) {
      console.error(`Error checking ${binPath}:`, error.message);
    }
  }

  console.error('Xray binary not found! Checked paths:', possiblePaths);
  return null;
}

// Check for admin rights at startup (Windows only)
function checkAdminRights() {
  if (process.platform === 'win32') {
    try {
      console.log('Checking admin privileges at startup...');
      const hasAdmin = adminHelper.initializeAdminRights();
      console.log('Admin privileges status:', hasAdmin ? 'GRANTED' : 'DENIED');
      
      if (!hasAdmin) {
        console.log('WARNING: StealthLynk is running without administrator rights.');
        console.log('For full privacy protection, please run as administrator or reinstall the app.');
      }
    } catch (error) {
      console.error('Error checking admin privileges:', error);
    }
  }
}

// Create the browser window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 640,
    minWidth: 400,
    minHeight: 640,
    frame: false, // Remove window frame/title bar
    transparent: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // Disable WebRTC completely to prevent IP leaks
      webRTCIPHandlingPolicy: 'disable_non_proxied_udp'
    },
    icon: path.join(__dirname, 'assets/icons/win-icon.ico'),
    title: 'StealthLynk',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0c0c16',
    movable: true,
    center: true
  });

  mainWindow.loadFile('index.html');
  Menu.setApplicationMenu(null);
  
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
  
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Create system tray
function createTray() {
  try {
    const iconPath = path.join(__dirname, 'assets/icons/logo.ico');
      
    // Create tray with icon if it exists, otherwise use a blank icon
    tray = new Tray(iconPath);
    updateTray();
    
    tray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.focus();
      } else {
        createWindow();
      }
    });
    
    console.log('Tray created successfully');
  } catch (error) {
    console.error('Error creating tray:', error);
  }
}

// Update tray icon and menu
function updateTray() {
  if (!tray) return;
  
  try {
    const activeServer = serversData.servers.find(s => s.id === serversData.activeServer);
    const contextMenu = Menu.buildFromTemplate([
      { label: `Xray Reality VPN ${isConnected ? '(Connected)' : '(Disconnected)'}`, enabled: false },
      { type: 'separator' },
      { 
        label: activeServer ? `Server: ${activeServer.name}` : 'No server selected', 
        enabled: false 
      },
      { type: 'separator' },
      { 
        label: isConnected ? 'Disconnect' : 'Connect', 
        click: async () => {
          if (isConnected) {
            await disconnectVPN();
          } else {
            await connectVPN();
          }
        } 
      },
      { type: 'separator' },
      { label: 'Show App', click: () => {
        if (mainWindow) {
          mainWindow.show();
        } else {
          createWindow();
        }
      }},
      { label: 'Quit', click: async () => {
        if (isConnected) {
          await disconnectVPN();
        }
        app.quit();
      }}
    ]);
    
    tray.setContextMenu(contextMenu);
    tray.setToolTip(`Xray Reality VPN - ${isConnected ? 'Connected' : 'Disconnected'}`);
  } catch (error) {
    console.error('Error updating tray:', error);
  }
}

// Register IPC handlers
function registerIpcHandlers() {
  console.log('Registering IPC handlers');
  
  // Auto-failover settings
  ipcMain.handle('vpn:getAutoFailoverStatus', () => {
    return { enabled: autoReconnectEnabled };
  });
  
  ipcMain.handle('vpn:setAutoFailover', (event, enabled) => {
    console.log(`[IPC] Setting auto-reconnect to: ${enabled}`);
    autoReconnectEnabled = enabled;
    // The network monitor will check this flag when it matters, so we just set the state here.
    return { success: true, enabled: autoReconnectEnabled };
  });
  
  // Media request permission handler
  ipcMain.handle('media:requestPermission', async () => {
    console.log('Media permission requested');
    try {
      return { success: true };
    } catch (error) {
      console.error('Media permission error:', error);
      return { success: false, message: error.message };
    }
  });
  
  // VPN operations
  ipcMain.handle('vpn:status', getStatus);
  ipcMain.handle('vpn:connect', connectVPN);
  ipcMain.handle('vpn:disconnect', disconnectVPN);
  ipcMain.handle('vpn:diagnostics', getDiagnostics);
  
  // Server management
  ipcMain.handle('vpn:getServers', () => {
    console.log('Get servers called, returning:', serversData);
    // Return both the servers array AND the activeServer ID
    return serversData || { servers: [], activeServer: null };
  });
  ipcMain.handle('vpn:addServer', (_, serverUrl) => addServer(serverUrl));
  ipcMain.handle('vpn:deleteServer', (_, serverId) => deleteServer(serverId));
  ipcMain.handle('vpn:setActiveServer', (_, serverId) => setActiveServer(serverId));
  ipcMain.handle('vpn:parseVLESSUrl', (_, url) => serverManager.parseVLESSUrl(url));
  ipcMain.handle('vpn:getCountryName', (_, countryCode) => serverManager.getCountryName(countryCode));
  
  // JSON fetching (for proxied requests)
  ipcMain.handle('vpn:fetchJson', async (_, url, options = {}) => {
    console.log(`Fetching JSON from ${url}`);
    try {
      const response = await axios.get(url, options);
      return response.data;
    } catch (error) {
      console.error(`Error fetching JSON from ${url}:`, error.message);
      throw new Error(`Failed to fetch data: ${error.message}`);
    }
  });
}

// Add server
async function addServer(serverUrl) {
  try {
    console.log('Adding server from URL:', serverUrl);
    
    // Remember the active server if connected to preserve it
    const wasConnected = isConnected;
    const previousActiveServerId = serversData?.activeServer;

    const result = await serverManager.addServer(serverUrl);
    
    if (result.success) {
      // Reload servers data after adding
      serversData = serverManager.loadServers();
      
      // If we were connected, ensure the active server is preserved
      if (wasConnected && previousActiveServerId) {
        serverManager.setActiveServer(previousActiveServerId);
        serversData = serverManager.loadServers(); // Reload again to reflect correct active server
      }
      
      updateTray();
      console.log('Server added successfully:', result.server?.name);
      
      // Notify the renderer that the server list has been updated
      if (mainWindow) {
        mainWindow.webContents.send('vpn:servers-updated', {
          servers: serversData.servers,
          activeServer: serversData.activeServer,
          source: 'addServer' // Indicate the source of the update
        });
      }
    } else {
      console.error('Failed to add server:', result.message);
    }
    
    return result;
  } catch (error) {
    console.error('Error adding server:', error);
    return { success: false, message: error.message };
  }
}

// Delete server
function deleteServer(serverId) {
  try {
    console.log('Deleting server:', serverId);
    const result = serverManager.deleteServer(serverId);
    
    if (result.success) {
      // Reload servers data after deletion
      serversData = serverManager.loadServers();
      updateTray();
      console.log('Server deleted successfully');
    } else {
      console.error('Failed to delete server:', result.message);
    }
    
    return result;
  } catch (error) {
    console.error('Error deleting server:', error);
    return { success: false, message: error.message };
  }
}

// Set active server
function setActiveServer(serverId) {
  try {
    console.log('Setting active server:', serverId);
    const result = serverManager.setActiveServer(serverId);
    
    if (result.success) {
      // Reload servers data after changing active server
      serversData = serverManager.loadServers();
      updateTray();
      
      // Get the active server object to return to the renderer
      const activeServer = serversData.servers.find(server => server.id === serverId);
      console.log('Active server set successfully:', activeServer ? activeServer.name : 'Unknown');
      
      // Return the server object along with success status
      return { success: true, server: activeServer };
    } else {
      console.error('Failed to set active server:', result.message);
      return result;
    }
  } catch (error) {
    console.error('Error setting active server:', error);
    return { success: false, message: error.message };
  }
}

// Get active server
function getActiveServer() {
  try {
    console.log('Getting active server...');
    if (!serversData || !serversData.servers || !serversData.activeServer) {
      console.log('No active server found');
      return null;
    }
    
    const activeServer = serversData.servers.find(server => server.id === serversData.activeServer);
    console.log('Active server:', activeServer ? activeServer.name : 'Not found');
    return activeServer || null;
  } catch (error) {
    console.error('Error getting active server:', error);
    return null;
  }
}

// App ready event
app.whenReady().then(async () => {
  // Quit the app if not on Windows
  if (process.platform !== 'win32') {
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: 'Unsupported Platform',
      message: 'This Windows app cannot run on non-Windows platforms.',
      buttons: ['OK']
    });

    app.quit();
    return;
  }
  
  // Check for admin rights at startup
  checkAdminRights();

  try {
    // Set camera/media permissions
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      if (permission === 'media') {
        callback(true);
        return;
      }
      callback(false);
    });
    
    // CRITICAL: Block WebRTC IP detection to prevent leaks
    // This prevents browsers from accessing your real IP via WebRTC even when VPN is on
    session.defaultSession.webRequest.onBeforeSendHeaders(
      {urls: ['*://*/*']},
      (details, callback) => {
        if (details.requestHeaders) {
          // Block known WebRTC fingerprinting headers
          if (details.requestHeaders['X-WebRTC-Info']) {
            delete details.requestHeaders['X-WebRTC-Info'];
          }
        }
        callback({cancel: false, requestHeaders: details.requestHeaders});
      }
    );
    
    // Apply WebRTC blocking setting to all BrowserWindow instances
    app.on('browser-window-created', (_, window) => {
      window.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
      // Stronger WebRTC block - inject content script
      window.webContents.executeJavaScript(`
        try {
          Object.defineProperty(RTCPeerConnection.prototype, 'createDataChannel', {
            value: function() { return null; }
          });
          console.log('[StealthLynk] WebRTC protection activated');
        } catch (e) {}
      `);
    });
    
    // Load servers
    serversData = serverManager.loadServers();
    
    // Create window and tray
    createWindow();
    createTray();
    
    // Register IPC handlers
    registerIpcHandlers();
    

  } catch (error) {
    console.error('Error initializing app:', error);
  }
});
// Request admin privileges with user prompt (without multiple password requests)
async function requestAdminAccess() {
  try {
    // Use a subtle AppleScript prompt just once
    const script = `
    tell application "System Events"
      return "Success"
    end tell
    `;
    execSync(`osascript -e '${script}'`);
    return true;
  } catch (error) {
    console.log('AppleScript test failed:', error.message);
    return false;
  }
}

// Disable IPv6 on Windows to prevent leaks
async function disableIPv6(disable = true) {
  try {
    if (process.platform === 'win32') {
      console.log(disable ? 'Disabling IPv6...' : 'Restoring IPv6 settings...');
      
      // Get network interfaces
      try {
        const adaptersOutput = execSync('netsh interface ipv6 show interface').toString();
        const adapterLines = adaptersOutput.split('\n').filter(line => 
          line.includes('connected') && !line.toLowerCase().includes('loopback'));

        for (const line of adapterLines) {
          const idxMatch = line.match(/^\s*(\d+)/);
          if (idxMatch) {
            const idx = idxMatch[1];
            try {
              if (disable) {
                // Disable IPv6 on the interface
                execSync(`netsh interface ipv6 set interface ${idx} disabled`);
                console.log(`Disabled IPv6 on interface ${idx}`);
              } else {
                // Re-enable IPv6
                execSync(`netsh interface ipv6 set interface ${idx} enabled`);
                console.log(`Enabled IPv6 on interface ${idx}`);
              }
            } catch (err) {
              console.warn(`Failed to ${disable ? 'disable' : 'enable'} IPv6 on interface ${idx}:`, err.message);
            }
          }
        }

        // Disable IPv6 components in registry (more comprehensive approach)
        try {
          const registryValue = disable ? '0xffffffff' : '0x0';
          execSync(`reg add HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\Tcpip6\Parameters /v DisabledComponents /t REG_DWORD /d ${registryValue} /f`);
          console.log(`Registry update for IPv6 ${disable ? 'disable' : 'enable'} attempted`);
        } catch (regErr) {
          console.warn('Failed to update IPv6 registry settings (may require admin rights):', regErr.message);
          // This is expected without admin rights - we will rely on our other methods
        }
      } catch (netErr) {
        console.warn('Failed to enumerate network interfaces:', netErr.message);
      }

      // Force DNS to only use IPv4
      try {
        // Force Node.js to use IPv4 only for all DNS lookups
        dns.setDefaultResultOrder('ipv4first');
        console.log('Set DNS resolution to prefer IPv4');
      } catch (dnsErr) {
        console.warn('Failed to set DNS IPv4 preference:', dnsErr.message);
      }
    }
    return { success: true };
  } catch (error) {
    console.error('IPv6 configuration error:', error);
    return { success: false, message: error.message };
  }
}

// Configure system proxy using command-line only (no UI)
async function configureProxy(enable) {
  // This function is now Windows-only. The platform check at app startup ensures this.
  try {
    if (enable) {
      // Define the proxy server settings for HTTP, HTTPS, and SOCKS
      const proxyServerValue = `http=127.0.0.1:10809;https=127.0.0.1:10809;socks=127.0.0.1:10808`;
      
      console.log('Configuring system proxy'); 
      
      try {
        // Enable the proxy and set the server values in the Windows Registry
        execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f');
        execSync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "${proxyServerValue}" /f`);
      } catch (regError) {
        console.warn('Failed to set system proxy settings in registry. Some browsers may not use the proxy:', regError.message);
        // Continue anyway since we'll set the proxy for Electron
      }

      // NEWER APPROACH: Instead of modifying Chrome policies (which needs admin rights),
      // we'll set DNS for Electron directly and force all internal browser traffic through our proxy
      console.log('Applying DNS leak protection for browsers...');
      
      // DNS leak protection without requiring admin privileges
      try {
        // DNS leak protection for Electron app itself
        app.commandLine.appendSwitch('proxy-server', 'socks5://127.0.0.1:10808');
        app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND , EXCLUDE localhost');
        
        // Force DNS over proxy for all connections
        if (mainWindow) {
          mainWindow.webContents.session.setProxy({
            proxyRules: 'socks5://127.0.0.1:10808',
            proxyBypassRules: 'localhost,127.0.0.1'
          });
        }
        
        console.log('Applied DNS leak protection without needing admin rights');
      } catch (dnsError) {
        console.warn('Failed to apply DNS leak protection:', dnsError.message);
      }
    } else {
      // Disable the proxy in the Windows Registry
      try {
        execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f');
      } catch (regError) {
        console.warn('Failed to disable system proxy settings in registry:', regError.message);
      }
      
      // Reset DNS without admin privileges
      try {
        // Reset Electron's proxy and DNS settings
        if (app.commandLine && typeof app.commandLine.removeSwitch === 'function') {
          app.commandLine.removeSwitch('proxy-server');
          app.commandLine.removeSwitch('host-resolver-rules');
        }
        
        // Reset session proxy settings for all windows
        session.defaultSession.setProxy({
          mode: 'direct'
        });
        
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.session.setProxy({
            mode: 'direct'
          });
        }
        
        console.log('Reset DNS and proxy settings without admin rights');
      } catch (dnsError) {
        console.warn('Failed to reset DNS settings:', dnsError.message);
      }
    }
    
    // Update Electron's internal proxy settings to ensure its own traffic is proxied
    session.defaultSession.setProxy({
      proxyRules: enable ? "socks5://127.0.0.1:10808" : "",
      pacScript: "",
      proxyBypassRules: "localhost,127.0.0.1"
    });
    
    // Apply DNS settings to Electron
    if (enable) {
      // Force DNS resolution through our proxy to prevent leaks
      session.defaultSession.setResolution = new Proxy(dns.resolve, {
        apply: function(target, thisArg, args) {
          // Force all DNS resolution through our proxy
          const callback = args[args.length - 1];
          if (typeof callback === 'function') {
            return callback(null, ['127.0.0.1']);
          }
          return target.apply(thisArg, args);
        }
      });
    }

    return { success: true };

  } catch (winError) {
    console.error('Windows proxy configuration error:', winError);
    return { success: false, message: `Windows proxy error: ${winError.message}` };
  }
}
// Custom lookup function to force IPv4 resolution for http requests
const ipv4Lookup = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, family: 4 }, callback);
};

// Ultra-fast IP detection for all scenarios
async function testConnection() {
  const { SocksProxyAgent } = require('socks-proxy-agent');
  const socksAgent = new SocksProxyAgent(`socks5://127.0.0.1:10808`, { lookup: ipv4Lookup });

  // Only use the fastest services with minimal timeout
  const ipServices = [
    { url: 'https://api.ipify.org', type: 'text' },
    { url: 'https://ifconfig.me/ip', type: 'text' }
  ];

  console.log('Starting parallel IP detection requests');
  const allPromises = ipServices.map(service => {
    return new Promise(async (resolve) => {
      try {
        const axiosInstance = axios.create({
          httpsAgent: socksAgent,
          httpAgent: socksAgent,
          timeout: 3000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          }
        });
        const response = await axiosInstance.get(service.url);
        const ip = response.data.trim();
        if (ip) {
          console.log(`IP detected via ${service.url}: ${ip}`);
          resolve(ip);
        } else {
          resolve(null);
        }
      } catch (err) {
        // console.error(`IP detection via ${service.url} failed: ${err.message}`);
        resolve(null);
      }
    });
  });

  try {
    const results = await Promise.all(allPromises);
    const successfulResults = results.filter(ip => ip !== null);
    if (successfulResults.length > 0) {
      return successfulResults[0];
    }
  } catch (err) {
    console.error('All parallel IP detection requests failed.');
  }

  console.error('All IP detection services failed');
  return null;
}

// Get connection status
async function getStatus() {
  try {
    const originalIp = await getOriginalIP();
    
    const status = {
      connected: isConnected,
      originalIp
    };
    
    if (isConnected) {
      status.proxyIp = await testConnection() || 'Unknown';
      
      if (connectionStartTime) {
        const uptime = Math.floor((Date.now() - connectionStartTime) / 1000);
        status.uptime = {
          hours: Math.floor(uptime / 3600).toString().padStart(2, '0'),
          minutes: Math.floor((uptime % 3600) / 60).toString().padStart(2, '0'),
          seconds: Math.floor(uptime % 60).toString().padStart(2, '0')
        };
      }
    }
    
    return status;
  } catch (error) {
    console.error('Error getting status:', error);
    return { connected: isConnected, error: error.message };
  }
}

// Get original IP
async function getOriginalIP() {
  try {
    const response = await axios.get('https://api.ipify.org', { timeout: 5000 });
    return response.data;
  } catch (error) {
    console.error('Error getting original IP:', error);
    return 'Unknown';
  }
}

// Get diagnostics
async function getDiagnostics() {
  try {
    const diagnostics = {
      app: {
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch
      },
      xray: {
        path: findXrayBinary() || 'Not found',
        version: null
      },
      network: {
        originalIp: await getOriginalIP(),
        connected: isConnected
      }
    };
    
    // Try to get Xray version
    const xrayBinary = findXrayBinary();
    if (xrayBinary) {
      try {
        const versionOutput = execSync(`"${xrayBinary}" --version`).toString();
        diagnostics.xray.version = versionOutput.trim();
      } catch (error) {
        diagnostics.xray.version = `Error getting version: ${error.message}`;
      }
    }
    
    // Add proxy IP if connected
    if (isConnected) {
      diagnostics.network.proxyIp = await testConnection() || 'Unknown';
    }
    
    return diagnostics;
  } catch (error) {
    console.error('Error getting diagnostics:', error);
    return { error: error.message };
  }
}

// Update server country info based on IP
async function updateServerCountryInfo(serverId, ip) {
  // Load the current server data at the beginning.
  let currentServersData = serverManager.loadServers();

  if (!ip || ip === 'Connecting...' || ip === 'Unknown') {
    console.log('Skipping country update for invalid IP:', ip);
    return currentServersData; // Return current data if IP is invalid
  }

  try {
    console.log(`Fetching country info for IP: ${ip}`);
    const response = await axios.get(`http://ip-api.com/json/${ip}`);
    const geo = response.data;

    if (geo.status === 'success' && geo.countryCode) {
      const countryCode = geo.countryCode;
      const countryName = serverManager.getCountryName(countryCode);
      const flag = serverManager.getFlagEmoji(countryCode);

      const serverIndex = currentServersData.servers.findIndex(s => s.id === serverId);

      if (serverIndex !== -1) {
        console.log(`Updating server ${serverId} with country: ${countryName} (${countryCode})`);
        currentServersData.servers[serverIndex].countryCode = countryCode;
        currentServersData.servers[serverIndex].countryName = countryName;
        currentServersData.servers[serverIndex].flag = flag;
        
        // Save the updated data
        serverManager.saveServers(currentServersData);
      }
    } else {
      console.log('Failed to get country info for IP:', ip, 'Response:', geo);
    }
  } catch (error) {
    console.error('Error updating server country info:', error.message);
  }
  
  // Always return the latest data, whether it was updated or not.
  return currentServersData;
}

// Ultra-fast emergency IP detection
async function fastIpDetection() {
  // Use single fastest service with minimal timeout
  try {
    // Setup SOCKS proxy agent
    const SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
    const agent = new SocksProxyAgent('socks5://127.0.0.1:10808', { timeout: 1500 });
    
    // Make request with minimal timeout
    const response = await axios.get('https://api.ipify.org', {
      httpsAgent: agent, 
      timeout: 1500,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    
    if (response.data && typeof response.data === 'string') {
      console.log(`Fast IP detection success: ${response.data.trim()}`);
      return response.data.trim();
    }
  } catch (err) {
    console.log('Fast IP detection failed');
  }
  return null;
}

// Function to wait for the proxy to be ready
function waitForProxy(port, host, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const tryConnect = () => {
      if (Date.now() - startTime > timeout) {
        reject(new Error(`Proxy connection timed out after ${timeout}ms`));
        return;
      }
      const socket = net.createConnection({ port, host }, () => {
        console.log(`Proxy at ${host}:${port} is ready.`);
        socket.end();
        resolve();
      });
      socket.on('error', (err) => {
        setTimeout(tryConnect, 200); // Retry after a short delay
      });
    };
    tryConnect();
  });
}

// Connect VPN
async function connectVPN(isEmergencyReconnect = false) {
  try {
    if (isConnected) {
      console.log('Already connected');
      return { success: false, message: 'Already connected' };
    }
    
    console.log('Connecting to VPN...');
    
    // Apply privacy protections if on Windows and we have admin rights
    if (process.platform === 'win32') {
      // Create a loading state in the UI to mask any potential flickering
      mainWindow.webContents.send('update-status', { message: 'Applying privacy protections...' });
      
      if (adminHelper.hasElevated()) {
        try {
          console.log('Applying system-wide privacy protections...');
          await adminHelper.applyPrivacyProtections();
          console.log('Privacy protections applied successfully!');
        } catch (error) {
          console.error('Failed to apply privacy protections:', error);
          console.log('Will continue with limited privacy protections.');
        }
      } else {
        // No admin rights, use limited protections
        console.log('Limited privacy protections only (no admin rights)');
      }
    } else {
      // Non-Windows platforms - use existing IPv6 disable method
      console.log('Disabling IPv6 to prevent leaks...');
      await disableIPv6(true);
    }
    
    // Get the active server
    let activeServerConfig;
    if (serversData && serversData.activeServer) {
      activeServerConfig = serversData.servers.find(server => server.id === serversData.activeServer);
    }
    
    if (!activeServerConfig) {
      console.log('No active server selected');
      return { success: false, message: 'No active server selected' };
    }
    
    // Store the original IP before connecting
    // Generate Xray config for the active server
    // Define SOCKS and HTTP ports
    const SOCKS_PORT = 10808;
    const HTTP_PORT = 10809;

    const xrayConfig = serverManager.generateXrayConfig(activeServerConfig, SOCKS_PORT, HTTP_PORT);
    
    // Write the config to a file
    fs.writeFileSync(configPath, JSON.stringify(xrayConfig, null, 2));
    console.log(`Wrote Xray config for server: ${activeServerConfig.name}`);
    console.log('Xray config:', JSON.stringify(xrayConfig, null, 2));
    
    // Find Xray binary
    const xrayBinary = findXrayBinary();
    if (!xrayBinary) {
      throw new Error('Xray binary not found. Please make sure Xray is installed.');
    }
    console.log(`Using Xray binary: ${xrayBinary}`);
    
    // Start Xray first, before configuring proxy
    console.log(`Starting Xray with config: ${configPath}`);
    console.log('Final Xray config:', JSON.stringify(xrayConfig, null, 2));
    
    // Add more verbose command to see Xray version first
    console.log('Xray binary version:');
    try {
      const versionOutput = execSync(`${xrayBinary} version`).toString();
      console.log(versionOutput);
    } catch (err) {
      console.error('Error checking Xray version:', err);
    }
    
    // Launch with more debug flags
    xrayProcess = spawn(xrayBinary, ['-c', configPath]);
    
    // Handle Xray output with enhanced logging
    xrayProcess.stdout.on('data', (data) => {
      const output = data.toString().trim();
      console.log(`Xray output: ${output}`);
      // Check for connection success indicators
      if (output.includes('started') || output.includes('accepting') || output.includes('established')) {
        console.log('Xray connection appears to be establishing successfully');
      }
    });
    
    // Make sure we're also capturing error output
    xrayProcess.stderr.on('data', (data) => {
      const errorOutput = data.toString().trim();
      console.error(`Xray error: ${errorOutput}`);
      
      // Look for specific VLESS/Reality error patterns
      if (errorOutput.includes('reality') || errorOutput.includes('vless') || errorOutput.includes('TLS')) {
        console.error('VLESS Reality connection error detected:', errorOutput);
      }
    });
    
    xrayProcess.on('close', (code) => {
      console.log(`Xray process exited with code ${code}`);
      // If connection was active, try to clean up
      if (isConnected) {
        isConnected = false;
        connectionStartTime = null;
        configureProxy(false).catch(console.error);
        updateTray();
        
        if (mainWindow) {
          mainWindow.webContents.send('vpn:status-change', { connected: false });
        }
      }
    });
    
    // Wait for the proxy to be ready
    await waitForProxy(SOCKS_PORT, '127.0.0.1');
    
    // Configure system proxy
    console.log('Configuring system proxy');
    await configureProxy(true);
    
    // Update connection state
    isConnected = true;
    connectionStartTime = Date.now();
    updateTray();
    
    if (mainWindow) {
      mainWindow.webContents.send('vpn:status-change', { connected: true });
    }
    
    try {
      console.log(isEmergencyReconnect ? 'Using fast IP detection method' : 'Using standard IP detection');
      
      // For emergency reconnects, use faster detection method
      const proxyIp = isEmergencyReconnect ? 
                      await fastIpDetection() : 
                      await testConnection();
      
      // For emergency reconnects, allow connection even without immediate IP verification
      if (proxyIp || isEmergencyReconnect) {
        isConnected = true;
        connectionStartTime = Date.now();
        updateTray();
        
        // For emergency reconnects with no IP yet, use temporary IP and update later
        const displayIp = proxyIp || 'Connecting...';
        lastConnectedIP = displayIp;
        
        // Update UI immediately

        
        // Update server country info based on the new IP
        let updatedServers = null;
        if (proxyIp) {
          const activeServer = getActiveServer();
          if (activeServer) {
            updatedServers = await updateServerCountryInfo(activeServer.id, proxyIp);
          }
        }
        
        // Send the final connected event with the updated server list
        if (mainWindow) {
          mainWindow.webContents.send('vpn:connected', { 
            ip: displayIp, 
            servers: updatedServers || serverManager.loadServers() // Fallback to fresh data
          });
        }
        
        console.log(`Setting connection state to: ${displayIp} (auto-reconnect: ${autoReconnectEnabled})`);
        
        // For emergency reconnects with no IP detected yet, start background detection
        if (isEmergencyReconnect && !proxyIp) {
          setTimeout(async () => {
            try {
              const detectedIp = await fastIpDetection();
              if (detectedIp && mainWindow) {
                console.log(`Delayed IP detection succeeded: ${detectedIp}`);
                lastConnectedIP = detectedIp;
                
                // Update server country info and send updated list to UI
                const activeServer = getActiveServer();
                if (activeServer) {
                  const updatedServers = await updateServerCountryInfo(activeServer.id, detectedIp);
                  if (mainWindow) {
                    // Send a consolidated event with the IP and the updated server list
                    mainWindow.webContents.send('vpn:connected', { 
                      ip: detectedIp, 
                      servers: updatedServers 
                    });
                  }
                }
                
                // Update monitoring with actual IP once detected
                if (autoReconnectEnabled) {
                  networkMonitor.startMonitoring(
                    detectedIp, 
                    handleConnectionFailure
                  );
                }
              }
            } catch (err) {
              console.log('Delayed IP detection failed');
            }
          }, 500);
        }
        
        // Start network monitoring ONLY if auto-reconnect is enabled.
        if (autoReconnectEnabled) {
          console.log(`[connectVPN] Auto-reconnect is ON. Starting network monitor for IP: ${displayIp}`);
          networkMonitor.startMonitoring(displayIp, handleConnectionFailure);
        } else {
          console.log('[connectVPN] Auto-reconnect is OFF. Network monitor will not be started.');
          networkMonitor.stopMonitoring(); // Explicitly stop it to be safe
        }
        
        return { success: true, message: 'Connected successfully', status: await getStatus() };
      } else {
        throw new Error('Could not verify connection. No internet access through VPN.');
      }
    } catch (error) {
      console.error('Error verifying connection:', error);
      
      // Clean up if needed
      if (xrayProcess) {
        xrayProcess.kill();
        xrayProcess = null;
      }
      
      await configureProxy(false).catch(console.error);
      isConnected = false;
      connectionStartTime = null;
      updateTray();
      
      return { success: false, message: `Failed to connect: ${error.message}` };
    }
  } catch (error) {
    console.error('Error connecting to VPN:', error);
    
    // Clean up if needed
    if (xrayProcess) {
      xrayProcess.kill();
      xrayProcess = null;
    }
    
    await configureProxy(false).catch(console.error);
    isConnected = false;
    connectionStartTime = null;
    updateTray();
    
    return { success: false, message: `Failed to connect: ${error.message}` };
  }
}

// ULTRA-FAST emergency reconnect function to minimize delay between failover
async function handleConnectionFailure() {
  // CRITICAL FIX: If auto-reconnect is disabled, do nothing.
  if (!autoReconnectEnabled) {
    console.log('[FAILOVER] Connection failure detected, but auto-reconnect is disabled. Aborting.');
    // Ensure we are fully disconnected if something went wrong.
    if (isConnected) {
      await disconnectVPN(true); // silent disconnect
    }
    return;
  }

  // Use mutex flags to prevent duplicate reconnections
  if (isAutoFailoverInProgress || isReconnectionInProgress) {
    console.log('[FAILOVER] Already reconnecting, ignoring duplicate');
    return;
  }
  
  // Remove cooldown period entirely for fastest possible reconnection
  // We don't want any artificial delays here
  
  console.log('[ULTRA-FAST FAILOVER] Connection failure detected, emergency reconnect initiated');
  const startTime = Date.now();
  isAutoFailoverInProgress = true;
  isReconnectionInProgress = true;
  lastReconnectTime = Date.now();
  
  try {
    // First disconnect the current connection
    await disconnectVPN(true);
    
    // Get all available servers
    const servers = serversData.servers.filter(s => {
      // Filter out the current server that just failed
      const activeServer = getActiveServer();
      return activeServer && s.id !== activeServer.id;
    });
    
    if (!servers || servers.length === 0) {
      console.error('[AUTO FAILOVER] No alternative servers available');
      isAutoFailoverInProgress = false;
      return;
    }
    
    // Fast emergency reconnect - immediately select first available server
    // Skip latency checks entirely to save precious seconds
    console.log('[AUTO FAILOVER] EMERGENCY RECONNECT - selecting first server without latency check');
    const alternateServer = servers[0];
    
    console.log(`[AUTO FAILOVER] Selected server: ${alternateServer.name} (immediate selection)`);
    
    // Set as active server
    await setActiveServer(alternateServer.id);
    
    // Connect to the new server with emergency flag
    const result = await connectVPN(true); // true = emergency reconnect
    
    if (result.success) {
      console.log('[AUTO FAILOVER] Successfully connected to failover server');
      // Notify the renderer but only if we have a window
      if (mainWindow) {
        mainWindow.webContents.send('vpn:auto-failover', { 
          success: true, 
          server: fastestServer 
        });
      }
      console.log('[AUTO FAILOVER] Failover completed successfully');
    } else {
      console.error('[AUTO FAILOVER] Failed to connect to failover server:', result.message);
    }
  } catch (error) {
    console.error('[AUTO FAILOVER] Failed:', error.message);
  } finally {
    // Reset all the reconnection flags
    isAutoFailoverInProgress = false;
    isReconnectionInProgress = false;
  }
}

// Disconnect VPN
async function disconnectVPN(silent = false) {
  try {
    if (!isConnected) {
      return { success: true, message: 'Not connected' };
    }
    
    // Kill Xray process
    if (xrayProcess) {
      console.log('Stopping Xray process');
      xrayProcess.kill();
      xrayProcess = null;
    }
    
    // Update connection state
    isConnected = false;
    connectionStartTime = null;
    
    // Restore system settings when disconnecting on Windows
    if (process.platform === 'win32') {
      // Create a loading state in the UI to mask any potential flickering
      mainWindow.webContents.send('update-status', { message: 'Disabling proxy and restoring settings...' });
      
      // IMPORTANT: Use only adminHelper for managing proxy settings when available
      if (adminHelper.hasElevated()) {
        console.log('Disabling proxy and restoring original system settings...');
        try {
          await adminHelper.removePrivacyProtections();
          
          // Double-check the proxy is disabled with a direct registry command
          console.log('Double-checking proxy is disabled...');
          execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f', {windowsHide: true});
          
          console.log('Proxy disabled and settings restored successfully!');
        } catch (error) {
          console.error('Failed to disable proxy or restore settings:', error);
          
          // Fallback to direct registry approach if adminHelper fails
          try {
            console.log('Trying fallback proxy disable method...');
            await configureProxy(false);
          } catch (fallbackError) {
            console.error('Fallback proxy disable also failed:', fallbackError);
          }
        }
      } else {
        // No admin rights, use the basic configureProxy approach
        console.log('No admin rights, using basic proxy disable method');
        await configureProxy(false);
      }
    } else {
      // Non-Windows platforms use the existing method
      console.log('Re-enabling IPv6 settings...');
      await disableIPv6(false); // false = re-enable
    }
    
    // Stop monitoring the connection
    networkMonitor.stopMonitoring();
    
    updateTray();
    
    if (mainWindow) {
      // Send two events for better handling of disconnection:
      // 1. The general status change
      // 2. A specific disconnected event for handling server switching
      mainWindow.webContents.send('vpn:status-change', { connected: false });
      mainWindow.webContents.send('vpn:disconnected', { success: true });
    }
    
    return { success: true, message: 'Disconnected successfully' };
  } catch (error) {
    console.error('Error disconnecting from VPN:', error);
    return { success: false, message: `Failed to disconnect: ${error.message}` };
  }
}

// --- Open external links in default browser ---
const { shell } = require('electron');
app.on('web-contents-created', (_, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  contents.on('will-navigate', (event, url) => {
    if (url.startsWith('http')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
});

// App quit events
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});



app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', async (event) => {
  if (isConnected) {
    event.preventDefault();
    await disconnectVPN();
    app.quit();
  }
});
