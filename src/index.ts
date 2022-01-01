import path from 'path'
import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    Menu,
    nativeImage,
    nativeTheme,
    powerSaveBlocker,
    Tray,
} from 'electron'

import { __static } from './util'

import { createLogger } from './helpers/logger'
import { loginManager } from './helpers/login'
import { moodleClient } from './helpers/moodle'
import { initializeStore, store, } from './helpers/store'
import { downloadManager } from './helpers/download'

import { i18nInit, i18n } from './helpers/i18next'

const { debug, log } = createLogger('APP')

// This allows TypeScript to pick up the magic constant that's auto-generated by Forge's Webpack
// plugin that tells the Electron app where to look for the Webpack-bundled app code (depending on
// whether you're running in development or production).
declare const MAIN_WINDOW_WEBPACK_ENTRY: string
const DEV = process.argv.includes('--dev')

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) { // eslint-disable-line global-require
    app.quit()
}

// exits if another instance is already open
if (!app.requestSingleInstanceLock()) {
    app.exit()
}

let tray: Tray = null
let iconImg = nativeImage.createFromPath(path.join(__static, '/icons/icon.ico'))
let trayImg = nativeImage.createFromPath(path.join(__static, '/icons/tray.png'))

let psbID: number

downloadManager.on('sync', () => {
    psbID = powerSaveBlocker.start('prevent-app-suspension')
    updateTrayContext()
})
downloadManager.on('stop', () => {
    if (powerSaveBlocker.isStarted(psbID)) powerSaveBlocker.stop(psbID)
    updateTrayContext()
})

const windowsLoginSettings = {
    // path: path.resolve(path.dirname(process.execPath), '../Update.exe'),
    args: [
        '--tray-only'
    ]
}

/**
 * Sets the login item for launching the app at login
 * 
 * If the --dev arg is passed to electron, it's a no-op (allows for development without setting
 * electron as a launch item)
 * @param openAtLogin whether the app should launch at login or not
 */
async function setLoginItem(openAtLogin: boolean) {
    if (DEV) return

    await app.whenReady()
    debug(`Setting openAtLogin to ${openAtLogin}`)
    app.setLoginItemSettings({
        openAtLogin,
        openAsHidden: true,
        ...windowsLoginSettings
    })
}

const createWindow = (): void => {
    app.dock?.show()
    debug('Creating new main windows')
    // Create the browser window.
    const mainWindow = new BrowserWindow({
        height: 600,
        width: 800,
        autoHideMenuBar: true,
        titleBarStyle: 'hidden',
        trafficLightPosition: { x: 9, y: 9 },
        minHeight: 460,
        minWidth: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        icon: iconImg
    })

    const send = (channel: string, ...args: any[]) => {
        if (!mainWindow.isDestroyed())
            mainWindow.webContents.send(channel, ...args)
    }

    // and load the index.html of the app.
    mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY)
    loginManager.on('token', async () => {
        send('is-logged', true)
        send('courses', await moodleClient.getCoursesWithoutCache())
    })
    loginManager.on('logout', () => send('is-logged', false))
    moodleClient.on('network_event', conn => send('network_event', conn))
    moodleClient.on('username', username => send('username', username))
    if (moodleClient.username) send('username', moodleClient.username)

    downloadManager.on('sync', () => send('syncing', true))
    downloadManager.on('stop', result => {
        send('syncing', false)
        send('sync-result', result)
    })
    downloadManager.on('progress', progress => send('progress', progress))
    downloadManager.on('state', state => send('download-state', state))
    downloadManager.on('new-files', files => send('new-files', files))

    moodleClient.on('courses', async c => send('courses', c))

    i18n.on('languageChanged', lng => send('language', {
        lng,
        bundle: i18n.getResourceBundle(lng, 'client')
    }))
}

function focus() {
    let windows = BrowserWindow.getAllWindows()
    if (windows.length === 0) createWindow()
    else windows[0].focus()
}

function setupTray() {
    tray = new Tray(trayImg)
    tray.setToolTip('Webeep Sync')
    tray.on('click', () => {
        process.platform === 'win32' ? focus() : undefined
    })
}

async function updateTrayContext() {
    if (!tray) return
    await initializeStore()
    const t = i18n.getFixedT(null, 'tray', null)

    const s = downloadManager.syncing
    const ae = store.data.settings.autosyncEnabled
    tray.setContextMenu(Menu.buildFromTemplate([
        // { label: 'WebeepSync', type: 'submenu' },
        { label: t('open'), click: () => focus() },
        { type: 'separator' },
        {
            label: s ? t('stopSyncing') : t('syncNow'),
            sublabel: s ? t('syncInProgress') : undefined,
            click: () => s ? downloadManager.stop() : downloadManager.sync()
        },
        {
            label: t('toggleAutosync', { toggle: ae ? t('toggle.off') : t('toggle.on') }),
            icon: path.join(__static, 'icons', ae ? 'pause.png' : 'play.png'),
            click: async () => {
                await downloadManager.setAutosync(!ae)
                BrowserWindow.getAllWindows()[0]?.webContents.send('autosync', !ae)
                updateTrayContext()
            }
        },
        { type: 'separator' },
        { label: t('quit'), role: 'quit' }
    ]))
}

// When another instance gets launched, focuses the main window
app.on('second-instance', () => {
    focus()
})

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', async () => {
    log('App ready!')
    const loginItemSettings = app.getLoginItemSettings(windowsLoginSettings)
    await initializeStore()

    // setup internationalization
    await i18nInit()
    await i18n.changeLanguage(store.data.settings.language)

    // if the app was opened at login, do not show the window, only launch it in the tray
    let trayOnly = loginItemSettings.wasOpenedAtLogin || process.argv.includes('--tray-only')
    if (!trayOnly || !store.data.settings.keepOpenInBackground) createWindow()
    else {
        debug('Starting app in tray only')
        app.dock?.hide()
    }

    nativeTheme.themeSource = store.data.settings.nativeThemeSource

    if (store.data.settings.keepOpenInBackground && store.data.settings.trayIcon) {
        setupTray()
        await updateTrayContext()
    }

    // handle launch item settings 
    // disabled is true only if there's a launch item present and it is set to false
    let disable = !(loginItemSettings.launchItems?.reduce((d, i) => i.enabled && d, true) ?? true)
    // if a launch item is already present but the user has disabled it from task manager,
    // settings.openAtLogin should be set to false
    if (disable) {
        store.data.settings.openAtLogin = false
        debug('openAtLogin was disabled from Task Manager, settings updated accordingly')
        await store.write()
    }
    await setLoginItem(store.data.settings.openAtLogin)
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', async () => {
    app.dock?.hide()
    await initializeStore()
    if (store.data.settings.keepOpenInBackground === false) {
        app.quit()
    }
})

app.on('activate', () => {
    // On OS X it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
    }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.

ipcMain.handle('window-control', (e, command: string) => {
    const win = BrowserWindow.getFocusedWindow()
    switch (command) {
        case 'min':
            win.minimize()
            break
        case 'max':
            win.isMaximized() ? win.unmaximize() : win.maximize()
            break
        case 'close':
            win.close()
            break
    }
})

// a catch all event to send everything needed right when the frontend loads
ipcMain.on('get-context', e => {
    e.reply('is-logged', loginManager.isLogged)
    e.reply('username', moodleClient.username)
    e.reply('syncing', downloadManager.syncing)
    e.reply('network_event', moodleClient.connected)
    let lng = store.data.settings.language
    e.reply('language', {
        lng,
        bundle: i18n.getResourceBundle(lng, 'client')
    })
    e.reply('courses', moodleClient.getCourses())
})

ipcMain.on('logout', async e => {
    await loginManager.logout()
})

ipcMain.on('request-login', async e => {
    await loginManager.createLoginWindow()
})

ipcMain.on('set-should-sync', async (e, courseid: number, shouldSync: boolean) => {
    await initializeStore()
    store.data.persistence.courses[courseid].shouldSync = shouldSync
    await store.write()
})

ipcMain.on('sync-start', e => downloadManager.sync())
ipcMain.on('sync-stop', e => downloadManager.stop())

ipcMain.on('sync-settings', async e => {
    await initializeStore()
    e.reply('download-path', store.data.settings.downloadPath)
    e.reply('autosync', store.data.settings.autosyncEnabled)
    e.reply('autosync-interval', store.data.settings.autosyncInterval)
})

ipcMain.on('select-download-path', async e => {
    let path = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory',],
        title: 'select download folder'
    })
    if (!path.canceled) {
        store.data.settings.downloadPath = path.filePaths[0]
        e.reply('download-path', path.filePaths[0])
        await store.write()
    }
})
ipcMain.on('set-autosync', async (e, sync: boolean) => {
    await downloadManager.setAutosync(sync)
    e.reply('autosync', sync)
    await updateTrayContext()
})

ipcMain.on('set-autosync-interval', async (e, interval: number) => {
    store.data.settings.autosyncInterval = interval
    e.reply('autosync-interval', interval)
    await store.write()
})

ipcMain.handle('lastsynced', e => {
    return store.data.persistence.lastSynced
})

ipcMain.handle('settings', e => {
    let settingsCopy = { ...store.data.settings }
    // this three settings are not managed in the settings menu
    delete settingsCopy.autosyncEnabled
    delete settingsCopy.downloadPath
    delete settingsCopy.autosyncInterval
    return settingsCopy
})

ipcMain.handle('version', () => app.getVersion())

// this event handles the settings update, has side effects
ipcMain.handle('set-settings', async (e, newSettings) => {
    store.data.settings = { ...store.data.settings, ...newSettings }

    // tray 
    if ((
        !store.data.settings.keepOpenInBackground
        || !store.data.settings.trayIcon
    ) && tray !== null) {
        tray.destroy()
        tray = null
    } else if (
        store.data.settings.keepOpenInBackground
        && store.data.settings.trayIcon
        && tray === null
    ) {
        setupTray()
        await updateTrayContext()
    }

    // language
    if (store.data.settings.language !== i18n.language) {
        const lang = store.data.settings.language
        debug(`language changed to: ${lang}`)
        await i18n.changeLanguage(lang)
        await updateTrayContext()   // updates the tray with the new language
    }

    // launch on stratup
    // TODO: set path and args for autoupdate
    await setLoginItem(store.data.settings.openAtLogin)
    await store.write()
})

ipcMain.handle('get-native-theme', e => {
    return nativeTheme.themeSource
})
ipcMain.on('set-native-theme', async (e, theme) => {
    nativeTheme.themeSource = theme
    store.data.settings.nativeThemeSource = theme
    await store.write()
})