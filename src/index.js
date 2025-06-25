if (require('electron-squirrel-startup')) {
    process.exit(0);
}

const { app, BrowserWindow, desktopCapturer, globalShortcut, session, ipcMain, shell, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { GoogleGenAI } = require('@google/genai');
const os = require('os');
const { spawn } = require('child_process');
// Audio utilities removed - app now focuses only on screenshot-based Q&A
const { getCustomSystemPrompt } = require('./utils/custom-prompts');

let geminiSession = null;
let mouseEventsIgnored = false;
let messageBuffer = '';
let isInitializingSession = false;

// Add conversation tracking variables
let currentSessionId = null;
let currentTranscription = '';
let conversationHistory = [];

function ensureDataDirectories() {
    const homeDir = os.homedir();
    const cheddarDir = path.join(homeDir, 'cheddar');
    const dataDir = path.join(cheddarDir, 'data');
    const imageDir = path.join(dataDir, 'image');
    const audioDir = path.join(dataDir, 'audio');

    [cheddarDir, dataDir, imageDir, audioDir].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });

    return { imageDir, audioDir };
}

// Conversation management functions
function initializeNewSession() {
    currentSessionId = Date.now().toString();
    currentTranscription = '';
    conversationHistory = [];
    console.log('New conversation session started:', currentSessionId);
}

function saveConversationTurn(transcription, aiResponse) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const conversationTurn = {
        timestamp: Date.now(),
        transcription: transcription.trim(),
        ai_response: aiResponse.trim(),
    };

    conversationHistory.push(conversationTurn);
    console.log('Saved conversation turn:', conversationTurn);

    // Send to renderer to save in IndexedDB
    sendToRenderer('save-conversation-turn', {
        sessionId: currentSessionId,
        turn: conversationTurn,
        fullHistory: conversationHistory,
    });
}

function getCurrentSessionData() {
    return {
        sessionId: currentSessionId,
        history: conversationHistory,
    };
}

function createWindow() {
    // Get layout preference (default to 'normal')
    let windowWidth = 900;
    let windowHeight = 400;

    // Try to get layout setting - we'll set up a proper way to read this after window is created
    // For now, use default normal layout

    const mainWindow = new BrowserWindow({
        width: windowWidth,
        height: windowHeight,
        frame: false,
        transparent: true,
        hasShadow: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        hiddenInMissionControl: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false,
            enableBlinkFeatures: 'GetDisplayMedia',
            webSecurity: true,
            allowRunningInsecureContent: false,
        },
        backgroundColor: '#00000000',
    });

    session.defaultSession.setDisplayMediaRequestHandler(
        (request, callback) => {
            desktopCapturer.getSources({ types: ['screen'] }).then(sources => {
                callback({ video: sources[0], audio: 'loopback' });
            });
        },
        { useSystemPicker: true }
    );

    mainWindow.setResizable(false);
    mainWindow.setContentProtection(true);
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Additional stealth settings
    if (process.platform === 'win32') {
        // Prevent window from stealing focus on Windows
        mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
        mainWindow.setSkipTaskbar(true);
    } else if (process.platform === 'darwin') {
        // macOS specific settings
        mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }

    // Center window at the top of the screen
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth } = primaryDisplay.workAreaSize;
    const x = Math.floor((screenWidth - windowWidth) / 2);
    const y = 0; // Or a small offset like 10, 20 if needed
    mainWindow.setPosition(x, y);



    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    // After window is created, check for layout preference and resize if needed
    mainWindow.webContents.once('dom-ready', () => {
        // Add a small delay to ensure DOM and localStorage are fully ready
        setTimeout(() => {
            // Load keybindings only (layout mode is handled by the UI components)
            const defaultKeybinds = getDefaultKeybinds();
            let keybinds = defaultKeybinds;

            // Try to load saved keybinds
            mainWindow.webContents
                .executeJavaScript(
                    `
                try {
                    const saved = localStorage.getItem('customKeybinds');
                    return saved ? JSON.parse(saved) : null;
                } catch (e) {
                    return null;
                }
            `
                )
                .then(savedKeybinds => {
                    if (savedKeybinds) {
                        keybinds = { ...defaultKeybinds, ...savedKeybinds };
                    }
                    updateGlobalShortcuts(keybinds, mainWindow);
                })
                .catch(() => {
                    // Fallback to default keybinds
                    updateGlobalShortcuts(keybinds, mainWindow);
                });
        }, 150);
    });

    ipcMain.on('view-changed', (event, view) => {
        if (view !== 'assistant') {
            mainWindow.setIgnoreMouseEvents(false);
        }
    });

    ipcMain.handle('window-minimize', () => {
        mainWindow.minimize();
    });

    // Handle keybind updates
    ipcMain.on('update-keybinds', (event, newKeybinds) => {
        updateGlobalShortcuts(newKeybinds, mainWindow);
    });
}

function getDefaultKeybinds() {
    const isMac = process.platform === 'darwin';
    return {
        moveUp: isMac ? 'Alt+Up' : 'Ctrl+Up',
        moveDown: isMac ? 'Alt+Down' : 'Ctrl+Down',
        moveLeft: isMac ? 'Alt+Left' : 'Ctrl+Left',
        moveRight: isMac ? 'Alt+Right' : 'Ctrl+Right',
        toggleVisibility: isMac ? 'Cmd+\\' : 'Ctrl+\\',
        toggleClickThrough: isMac ? 'Cmd+M' : 'Ctrl+M',
        nextStep: isMac ? 'Cmd+Enter' : 'Ctrl+Enter',
        manualScreenshot: isMac ? 'Cmd+Shift+S' : 'Ctrl+Shift+S',
        toggleAudio: isMac ? 'Cmd+Shift+A' : 'Ctrl+Shift+A',
        exitApp: isMac ? 'Cmd+Q' : 'Ctrl+Q',
        previousResponse: isMac ? 'Cmd+[' : 'Ctrl+[',
        nextResponse: isMac ? 'Cmd+]' : 'Ctrl+]',
    };
}

function updateGlobalShortcuts(keybinds, mainWindow) {
    console.log('Updating global shortcuts with:', keybinds);

    // Unregister all existing shortcuts
    globalShortcut.unregisterAll();

    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    const moveIncrement = Math.floor(Math.min(width, height) * 0.1);

    // Register window movement shortcuts
    const movementActions = {
        moveUp: () => {
            if (!mainWindow.isVisible()) return;
            const [currentX, currentY] = mainWindow.getPosition();
            mainWindow.setPosition(currentX, currentY - moveIncrement);
        },
        moveDown: () => {
            if (!mainWindow.isVisible()) return;
            const [currentX, currentY] = mainWindow.getPosition();
            mainWindow.setPosition(currentX, currentY + moveIncrement);
        },
        moveLeft: () => {
            if (!mainWindow.isVisible()) return;
            const [currentX, currentY] = mainWindow.getPosition();
            mainWindow.setPosition(currentX - moveIncrement, currentY);
        },
        moveRight: () => {
            if (!mainWindow.isVisible()) return;
            const [currentX, currentY] = mainWindow.getPosition();
            mainWindow.setPosition(currentX + moveIncrement, currentY);
        },
    };

    // Register each movement shortcut
    Object.keys(movementActions).forEach(action => {
        const keybind = keybinds[action];
        if (keybind) {
            try {
                globalShortcut.register(keybind, movementActions[action]);
                console.log(`Registered ${action}: ${keybind}`);
            } catch (error) {
                console.error(`Failed to register ${action} (${keybind}):`, error);
            }
        }
    });

    // Register toggle visibility shortcut
    if (keybinds.toggleVisibility) {
        try {
            globalShortcut.register(keybinds.toggleVisibility, () => {
                if (mainWindow.isVisible()) {
                    mainWindow.hide();
                } else {
                    // Check if stealth mode is active
                    if (mainWindow.webContents && mainWindow.webContents.isStealthMode) {
                        mainWindow.showInactive();
                    } else {
                        mainWindow.show();
                    }
                }
            });
            console.log(`Registered toggleVisibility: ${keybinds.toggleVisibility}`);
        } catch (error) {
            console.error(`Failed to register toggleVisibility (${keybinds.toggleVisibility}):`, error);
        }
    }

    // Register toggle click-through shortcut
    if (keybinds.toggleClickThrough) {
        try {
            globalShortcut.register(keybinds.toggleClickThrough, () => {
                mouseEventsIgnored = !mouseEventsIgnored;
                if (mouseEventsIgnored) {
                    mainWindow.setIgnoreMouseEvents(true, { forward: true });
                    console.log('Mouse events ignored');
                } else {
                    mainWindow.setIgnoreMouseEvents(false);
                    console.log('Mouse events enabled');
                }
                mainWindow.webContents.send('click-through-toggled', mouseEventsIgnored);
            });
            console.log(`Registered toggleClickThrough: ${keybinds.toggleClickThrough}`);
        } catch (error) {
            console.error(`Failed to register toggleClickThrough (${keybinds.toggleClickThrough}):`, error);
        }
    }

    // Register next step shortcut
    if (keybinds.nextStep) {
        try {
            globalShortcut.register(keybinds.nextStep, async () => {
                console.log('Next step shortcut triggered');
                try {
                    if (geminiSession) {
                        await geminiSession.sendRealtimeInput({ text: 'What should be the next step here' });
                        console.log('Sent "next step" message to Gemini');
                    } else {
                        console.log('No active Gemini session');
                    }
                } catch (error) {
                    console.error('Error sending next step message:', error);
                }
            });
            console.log(`Registered nextStep: ${keybinds.nextStep}`);
        } catch (error) {
            console.error(`Failed to register nextStep (${keybinds.nextStep}):`, error);
        }
    }

    // Register manual screenshot shortcut
    if (keybinds.manualScreenshot) {
        try {
            globalShortcut.register(keybinds.manualScreenshot, () => {
                console.log('Manual screenshot shortcut triggered');

                // Don't bring app window to front - capture whatever is currently active
                // Execute screenshot capture immediately
                mainWindow.webContents.executeJavaScript(`
                    if (window.captureManualScreenshot) {
                        window.captureManualScreenshot().then(() => {
                            console.log('Manual screenshot completed');
                        }).catch(err => {
                            console.error('Manual screenshot failed:', err);
                        });
                    } else {
                        console.log('Manual screenshot function not available');
                    }
                `);
            });
            console.log(`Registered manualScreenshot: ${keybinds.manualScreenshot}`);
        } catch (error) {
            console.error(`Failed to register manualScreenshot (${keybinds.manualScreenshot}):`, error);
        }
    }

    // Register previous response shortcut
    if (keybinds.previousResponse) {
        try {
            globalShortcut.register(keybinds.previousResponse, () => {
                console.log('Previous response shortcut triggered');
                sendToRenderer('navigate-previous-response');
            });
            console.log(`Registered previousResponse: ${keybinds.previousResponse}`);
        } catch (error) {
            console.error(`Failed to register previousResponse (${keybinds.previousResponse}):`, error);
        }
    }

    // Register next response shortcut
    if (keybinds.nextResponse) {
        try {
            globalShortcut.register(keybinds.nextResponse, () => {
                console.log('Next response shortcut triggered');
                sendToRenderer('navigate-next-response');
            });
            console.log(`Registered nextResponse: ${keybinds.nextResponse}`);
        } catch (error) {
            console.error(`Failed to register nextResponse (${keybinds.nextResponse}):`, error);
        }
    }

    // Audio toggle removed - app now focuses only on screenshot-based Q&A

    // Register exit app shortcut
    if (keybinds.exitApp) {
        try {
            globalShortcut.register(keybinds.exitApp, () => {
                console.log('Exit app shortcut triggered');
                app.quit();
            });
            console.log(`Registered exitApp: ${keybinds.exitApp}`);
        } catch (error) {
            console.error(`Failed to register exitApp (${keybinds.exitApp}):`, error);
        }
    }
}

async function initializeGeminiSession(apiKey, customPrompt = '', profile = 'interview', language = 'en-US') {
    if (isInitializingSession) {
        console.log('Session initialization already in progress');
        return false;
    }

    isInitializingSession = true;
    sendToRenderer('session-initializing', true);

    const client = new GoogleGenAI({
        vertexai: false,
        apiKey: apiKey,
    });

    // Get enabled tools for Gemini configuration
    const enabledTools = await getEnabledTools();

    // Use custom prompts directly - all profiles now use custom-prompts.js
    const systemPrompt = getCustomSystemPrompt('exam', language);

    // Initialize new conversation session
    initializeNewSession();

    try {
        const session = await client.live.connect({
            model: 'gemini-2.0-flash-live-001',
            callbacks: {
                onopen: function () {
                    sendToRenderer('update-status', 'Connected to Gemini - Starting recording...');
                },
                onmessage: function (message) {
                    console.log('----------------', message);

                    // Handle transcription input
                    if (message.serverContent?.inputTranscription?.text) {
                        currentTranscription += message.serverContent.inputTranscription.text;
                    }

                    // Handle AI model response
                    if (message.serverContent?.modelTurn?.parts) {
                        for (const part of message.serverContent.modelTurn.parts) {
                            console.log(part);
                            if (part.text) {
                                messageBuffer += part.text;
                            }
                        }
                    }

                    if (message.serverContent?.generationComplete) {
                        sendToRenderer('update-response', messageBuffer);

                        // Save conversation turn when we have both transcription and AI response
                        if (currentTranscription && messageBuffer) {
                            saveConversationTurn(currentTranscription, messageBuffer);
                            currentTranscription = ''; // Reset for next turn
                        }

                        messageBuffer = '';
                    }

                    if (message.serverContent?.turnComplete) {
                        sendToRenderer('update-status', 'Listening...');
                    }
                },
                onerror: function (e) {
                    console.debug('Error:', e.message);
                    sendToRenderer('update-status', 'Error: ' + e.message);
                },
                onclose: function (e) {
                    console.debug('Session closed:', e.reason);
                    sendToRenderer('update-status', 'Session closed');
                },
            },
            config: {
                responseModalities: ['TEXT'],
                tools: enabledTools,
                inputAudioTranscription: {},
                contextWindowCompression: { slidingWindow: {} },
                speechConfig: { languageCode: language },
                systemInstruction: {
                    parts: [{ text: systemPrompt }],
                },
            },
        });

        geminiSession = session;
        isInitializingSession = false;
        sendToRenderer('session-initializing', false);
        return true;
    } catch (error) {
        console.error('Failed to initialize Gemini session:', error);
        isInitializingSession = false;
        sendToRenderer('session-initializing', false);
        return false;
    }
}

function sendToRenderer(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
        windows[0].webContents.send(channel, data);
    }
}

async function getEnabledTools() {
    const tools = [];

    // Check if Google Search is enabled (default: true)
    const googleSearchEnabled = await getStoredSetting('googleSearchEnabled', 'true');
    console.log('Google Search enabled:', googleSearchEnabled);

    if (googleSearchEnabled === 'true') {
        tools.push({ googleSearch: {} });
        console.log('Added Google Search tool');
    } else {
        console.log('Google Search tool disabled');
    }

    return tools;
}

async function getStoredSetting(key, defaultValue) {
    try {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
            // Wait a bit for the renderer to be ready
            await new Promise(resolve => setTimeout(resolve, 100));

            // Try to get setting from renderer process localStorage
            const value = await windows[0].webContents.executeJavaScript(`
                (function() {
                    try {
                        if (typeof localStorage === 'undefined') {
                            console.log('localStorage not available yet for ${key}');
                            return '${defaultValue}';
                        }
                        const stored = localStorage.getItem('${key}');
                        console.log('Retrieved setting ${key}:', stored);
                        return stored || '${defaultValue}';
                    } catch (e) {
                        console.error('Error accessing localStorage for ${key}:', e);
                        return '${defaultValue}';
                    }
                })()
            `);
            return value;
        }
    } catch (error) {
        console.error('Error getting stored setting for', key, ':', error.message);
    }
    console.log('Using default value for', key, ':', defaultValue);
    return defaultValue;
}

// macOS audio functions removed - app now focuses only on screenshot-based Q&A

// All audio capture functions removed - app now focuses only on screenshot-based Q&A

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    // App cleanup - audio functions removed
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

ipcMain.handle('initialize-gemini', async (event, apiKey, customPrompt, profile = 'interview', language = 'en-US') => {
    return await initializeGeminiSession(apiKey, customPrompt, profile, language);
});

// Audio IPC handlers removed - app now focuses only on screenshot-based Q&A

ipcMain.handle('send-image-content', async (event, { data, debug }) => {
    if (!geminiSession) return { success: false, error: 'No active Gemini session' };

    try {
        if (!data || typeof data !== 'string') {
            console.error('Invalid image data received');
            return { success: false, error: 'Invalid image data' };
        }

        const buffer = Buffer.from(data, 'base64');

        if (buffer.length < 1000) {
            console.error(`Image buffer too small: ${buffer.length} bytes`);
            return { success: false, error: 'Image buffer too small' };
        }

        process.stdout.write('!');
        await geminiSession.sendRealtimeInput({
            media: { data: data, mimeType: 'image/jpeg' },
        });

        return { success: true };
    } catch (error) {
        console.error('Error sending image:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('send-text-message', async (event, text) => {
    if (!geminiSession) return { success: false, error: 'No active Gemini session' };

    try {
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return { success: false, error: 'Invalid text message' };
        }

        console.log('Sending text message:', text);
        await geminiSession.sendRealtimeInput({ text: text.trim() });
        return { success: true };
    } catch (error) {
        console.error('Error sending text:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('start-macos-audio', async event => {
    if (process.platform !== 'darwin') {
        return {
            success: false,
            error: 'macOS audio capture only available on macOS',
        };
    }

    try {
        const success = await startMacOSAudioCapture();
        return { success };
    } catch (error) {
        console.error('Error starting macOS audio capture:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('stop-macos-audio', async event => {
    try {
        stopMacOSAudioCapture();
        return { success: true };
    } catch (error) {
        console.error('Error stopping macOS audio capture:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('close-session', async event => {
    try {
        stopMacOSAudioCapture();

        // Cleanup any pending resources and stop audio/video capture
        if (geminiSession) {
            await geminiSession.close();
            geminiSession = null;
        }

        return { success: true };
    } catch (error) {
        console.error('Error closing session:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('quit-application', async event => {
    try {
        stopMacOSAudioCapture();
        app.quit();
        return { success: true };
    } catch (error) {
        console.error('Error quitting application:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('open-external', async (event, url) => {
    try {
        await shell.openExternal(url);
        return { success: true };
    } catch (error) {
        console.error('Error opening external URL:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('toggle-window-visibility', async event => {
    try {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
            const mainWindow = windows[0];
            if (mainWindow.isVisible()) {
                mainWindow.hide();
            } else {
                // Check if stealth mode is active
                if (mainWindow.webContents && mainWindow.webContents.isStealthMode) {
                    mainWindow.showInactive();
                } else {
                    mainWindow.show();
                }
            }
        }
        return { success: true };
    } catch (error) {
        console.error('Error toggling window visibility:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('enable-stealth-mode', async event => {
    try {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
            const mainWindow = windows[0];
            // Mark stealth mode as active
            mainWindow.webContents.isStealthMode = true;
            // Restore stealth behavior - prevent focus stealing
            mainWindow.setFocusable(false);
            console.log('Stealth mode enabled - window is now non-focusable');
        }
        return { success: true };
    } catch (error) {
        console.error('Error enabling stealth mode:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('disable-stealth-mode', async event => {
    try {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
            const mainWindow = windows[0];
            // Mark stealth mode as inactive
            mainWindow.webContents.isStealthMode = false;
            // Ensure window is focusable again
            mainWindow.setFocusable(true);
            console.log('Stealth mode disabled');
        }
        return { success: true };
    } catch (error) {
        console.error('Error disabling stealth mode:', error);
        return { success: false, error: error.message };
    }
});

// Conversation history IPC handlers
ipcMain.handle('get-current-session', async event => {
    try {
        return { success: true, data: getCurrentSessionData() };
    } catch (error) {
        console.error('Error getting current session:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('start-new-session', async event => {
    try {
        initializeNewSession();
        return { success: true, sessionId: currentSessionId };
    } catch (error) {
        console.error('Error starting new session:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('update-google-search-setting', async (event, enabled) => {
    try {
        console.log('Google Search setting updated to:', enabled);
        // The setting is already saved in localStorage by the renderer
        // This is just for logging/confirmation
        return { success: true };
    } catch (error) {
        console.error('Error updating Google Search setting:', error);
        return { success: false, error: error.message };
    }
});

// Audio control IPC handlers removed - app now focuses only on screenshot-based Q&A

// Add layout mode handler
ipcMain.handle('update-layout-mode', async (event, layoutMode) => {
    try {
        console.log('Layout mode update requested:', layoutMode);

        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
            const mainWindow = windows[0];

            let targetWidth, targetHeight;

            if (layoutMode === 'compact') {
                targetWidth = 700;
                targetHeight = 300;
            } else {
                // Assumes 'normal' or default
                targetWidth = 900;
                targetHeight = 400;
            }

            const [currentWidth, currentHeight] = mainWindow.getSize();
            console.log('Current window size:', currentWidth, 'x', currentHeight);

            if (currentWidth !== targetWidth || currentHeight !== targetHeight) {
                mainWindow.setSize(targetWidth, targetHeight);
                console.log(`Window resized to ${layoutMode} mode: ${targetWidth}x${targetHeight}`);
            } else {
                console.log(`Window already in ${layoutMode} size`);
            }

            // Re-center the window at the top
            const primaryDisplay = screen.getPrimaryDisplay();
            const { width: screenWidth } = primaryDisplay.workAreaSize;
            const x = Math.floor((screenWidth - targetWidth) / 2);
            const y = 0; // Position at the top
            mainWindow.setPosition(x, y);
            console.log(`Window re-centered to x: ${x}, y: ${y} for ${layoutMode} mode (width: ${targetWidth})`);

            // Verify the resize worked (optional, can be kept or removed)
            setTimeout(() => {
                const [newWidth, newHeight] = mainWindow.getSize();
                console.log('Window size after resize:', newWidth, 'x', newHeight);
            }, 100);
        } else {
            console.warn('No windows found for layout mode update');
        }

        return { success: true };
    } catch (error) {
        console.error('Error updating layout mode:', error);
        return { success: false, error: error.message };
    }
});

// Add view-based window resizing handler
ipcMain.handle('resize-for-view', async (event, viewName, layoutMode = 'normal') => {
    try {
        console.log('View-based resize requested:', viewName, 'layout:', layoutMode);

        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
            const mainWindow = windows[0];

            let targetWidth, targetHeight;

            // Determine base size from layout mode
            const baseWidth = layoutMode === 'compact' ? 700 : 900;
            const baseHeight = layoutMode === 'compact' ? 300 : 400;

            // Adjust height based on view
            switch (viewName) {
                case 'customize':
                case 'settings':
                    targetWidth = baseWidth;
                    targetHeight = layoutMode === 'compact' ? 500 : 600;
                    break;
                case 'help':
                    targetWidth = baseWidth;
                    targetHeight = layoutMode === 'compact' ? 450 : 550;
                    break;
                case 'history':
                    targetWidth = baseWidth;
                    targetHeight = layoutMode === 'compact' ? 450 : 550;
                    break;
                case 'advanced':
                    targetWidth = baseWidth;
                    targetHeight = layoutMode === 'compact' ? 400 : 500;
                    break;
                case 'main':
                case 'assistant':
                case 'onboarding':
                default:
                    // Use base dimensions for other views
                    targetWidth = baseWidth;
                    targetHeight = baseHeight;
                    break;
            }

            const [currentWidth, currentHeight] = mainWindow.getSize();
            console.log('Current window size:', currentWidth, 'x', currentHeight);

            if (currentWidth !== targetWidth || currentHeight !== targetHeight) {
                mainWindow.setSize(targetWidth, targetHeight);
                console.log(`Window resized for ${viewName} view (${layoutMode}): ${targetWidth}x${targetHeight}`);
            } else {
                console.log(`Window already correct size for ${viewName} view`);
            }

            // Re-center the window at the top
            const primaryDisplay = screen.getPrimaryDisplay();
            const { width: screenWidth } = primaryDisplay.workAreaSize;
            const x = Math.floor((screenWidth - targetWidth) / 2);
            const y = 0; // Position at the top
            mainWindow.setPosition(x, y);
            console.log(`Window re-centered to x: ${x}, y: ${y} for ${viewName} view (width: ${targetWidth})`);

            // Verify the resize worked
            setTimeout(() => {
                const [newWidth, newHeight] = mainWindow.getSize();
                console.log('Window size after view resize:', newWidth, 'x', newHeight);
            }, 50);
        } else {
            console.warn('No windows found for view resize');
        }

        return { success: true };
    } catch (error) {
        console.error('Error resizing for view:', error);
        return { success: false, error: error.message };
    }
});
