import { AcquisitionManager as Sdk } from 'code-push/script/acquisition-sdk';
import { Alert } from './AlertAdapter';
import requestFetchAdapter from './request-fetch-adapter';
import { AppState, Platform, Image, PixelRatio } from 'react-native';
import log from './logging';
import hoistStatics from 'hoist-non-react-statics';

let NativeCodePush = require('react-native').NativeModules.CodePush;
const PackageMixins = require('./package-mixins')(NativeCodePush);

// ============================================
// CODEPUSH ASSET RESOLVER (iOS + Android)
// ============================================
// Patches Image.resolveAssetSource to load assets from CodePush bundle folder.
// Android: drawable-* + resource name (Metro format). iOS: assets/.../name@?x.ext (Metro getScaledAssetPath).
// Parity with hot-updater: getBaseURL() / getPackageFolderPath() = bundle directory; assets live at
// basePath + "/assets/..." (iOS) or basePath + "/drawable-*/..." (Android), same as extracted zip layout.

let codePushBasePath = null;
let assetResolverPatched = false;

/**
 * Get the base URL for the current CodePush update folder.
 * @returns {string | null} Base URL like "file:///data/.../CodePush/build" or null
 */
function getBaseURL() {
    return codePushBasePath;
}

/**
 * Register getBaseURL to global objects for use without imports.
 */
function registerGlobalGetBaseURL() {
    const fn = getBaseURL;
    if (typeof globalThis !== 'undefined' && !globalThis.CodePushGetBaseURL) {
        globalThis.CodePushGetBaseURL = fn;
    }
    if (typeof global !== 'undefined' && !global.CodePushGetBaseURL) {
        global.CodePushGetBaseURL = fn;
    }
}

/**
 * Pick the best scale for the current device from available scales.
 */
function pickScale(scales) {
    const deviceScale = PixelRatio.get();
    let bestScale = 1;
    for (const scale of scales) {
        if (scale <= deviceScale && scale > bestScale) {
            bestScale = scale;
        }
    }
    return bestScale;
}

/**
 * Get the Android drawable folder name for a given scale.
 */
function getAndroidDrawableFolder(scale) {
    switch (scale) {
        case 0.75:
            return 'drawable-ldpi';
        case 1:
            return 'drawable-mdpi';
        case 1.5:
            return 'drawable-hdpi';
        case 2:
            return 'drawable-xhdpi';
        case 3:
            return 'drawable-xxhdpi';
        case 4:
            return 'drawable-xxxhdpi';
        default:
            return 'drawable-mdpi';
    }
}

/**
 * Get the Android resource name using Metro's algorithm (hot-updater style).
 * Assets are renamed to have __ prefix to match hot-updater bundle format.
 *
 * Metro's algorithm:
 * 1. Get basePath from httpServerLocation (remove leading /)
 * 2. Combine with name: `${basePath}/${name}`
 * 3. toLowerCase()
 * 4. Replace / with _
 * 5. Remove all non-alphanumeric chars (except _) - this removes . from ../ paths
 * 6. Remove "assets_" prefix if present
 */
function getAndroidResourceName(httpServerLocation, name) {
    let basePath = httpServerLocation;
    if (basePath[0] === '/') {
        basePath = basePath.substr(1);
    }

    return `${basePath}/${name}`
        .toLowerCase()
        .replace(/\//g, '_') // Encode folder structure in file name
        .replace(/([^a-z0-9_])/g, '') // Remove illegal chars (including . for ../)
        .replace(/^assets_/, ''); // Remove "assets_" prefix (keeps __ prefix)
}

/**
 * Get the iOS asset path (Metro getScaledAssetPath style).
 * Matches build folder: assets/.../name@2x.png
 * Path is relative to package folder (codePushBasePath).
 * Aligned with hot-updater: getBaseURL() = bundle directory, assets at baseURL + "assets/.../name@?x.ext"
 * and with RN AssetSourceResolver.getScaledAssetPath (getBasePath(asset) + '/' + name + scaleSuffix + '.' + type).
 */
function getIOSAssetPath(asset, scale) {
    let basePath = asset.httpServerLocation
        ? asset.httpServerLocation[0] === '/'
            ? asset.httpServerLocation.slice(1)
            : asset.httpServerLocation
        : 'assets';
    if (!basePath || basePath.trim() === '') {
        basePath = 'assets';
    }
    const scaleSuffix = scale === 1 ? '' : `@${scale}x`;
    // Replace ../ with _ so paths stay under assets/ (same as AssetSourceResolver.scaledAssetURLNearBundle)
    const safeBase = basePath.replace(/\.\.\//g, '_');
    return `${safeBase}/${asset.name}${scaleSuffix}.${asset.type}`;
}

/**
 * Normalize base path (no trailing slash) for building asset URIs.
 */
function getAssetBasePath() {
    if (!codePushBasePath) return '';
    return codePushBasePath.endsWith('/') ? codePushBasePath.slice(0, -1) : codePushBasePath;
}

/**
 * Patch Image.resolveAssetSource to use CodePush bundle path for assets.
 * Android: drawable-* + resource name. iOS: assets/ path (Metro getScaledAssetPath style).
 */
function patchAssetResolver() {
    if (assetResolverPatched || !codePushBasePath) {
        return;
    }

    // Use the official custom source transformer API (React Native 0.72+)
    if (typeof Image.resolveAssetSource?.addCustomSourceTransformer === 'function') {
        const basePath = getAssetBasePath();

        Image.resolveAssetSource.addCustomSourceTransformer((resolver) => {
            const asset = resolver.asset;

            // Only handle assets that have Metro packager metadata
            if (!asset || !asset.__packager_asset || !asset.httpServerLocation) {
                return resolver.defaultAsset();
            }

            // Skip non-drawable assets (fonts, etc.) for image resolution
            const drawableTypes = ['gif', 'jpeg', 'jpg', 'png', 'webp', 'xml'];
            if (!drawableTypes.includes(asset.type)) {
                return resolver.defaultAsset();
            }

            const scales = asset.scales || [1];
            const scale = scales.length === 1 ? 1 : pickScale(scales);
            let uri;

            if (Platform.OS === 'android') {
                const folder = getAndroidDrawableFolder(scale);
                const resourceName = getAndroidResourceName(asset.httpServerLocation, asset.name);
                const fileName = `${resourceName}.${asset.type}`;
                uri = `${basePath}/${folder}/${fileName}`;
            } else {
                // iOS: same structure as Metro output in build/assets/ (getScaledAssetPath)
                const relativePath = getIOSAssetPath(asset, scale);
                uri = `${basePath}/${relativePath}`;
            }

            log(`[CodePush] Asset resolved (${Platform.OS}): ${asset.name} -> ${uri}`);

            return {
                __packager_asset: true,
                width: asset.width,
                height: asset.height,
                uri: uri,
                scale: scale
            };
        });

        assetResolverPatched = true;
        log('[CodePush] Asset resolver patched using addCustomSourceTransformer (iOS + Android)');
    } else {
        log('[CodePush] addCustomSourceTransformer not available - assets may not load from CodePush');
    }
}

/**
 * Initialize the CodePush base path from native (both iOS and Android).
 * Sets codePushBasePath so getBaseURL() works on both platforms.
 * Patches Image.resolveAssetSource for drawable assets on both iOS and Android.
 */
async function initializeAssetResolver() {
    if (!NativeCodePush || typeof NativeCodePush.getPackageFolderPath !== 'function') {
        log('[CodePush] getPackageFolderPath not available');
        return;
    }

    try {
        let basePath = await NativeCodePush.getPackageFolderPath();
        if (basePath) {
            // When the bundle is inside a "build" subfolder (e.g. .../CodePush/<hash>/build/index.ios.bundle),
            // assets are under .../CodePush/<hash>/build/assets/. Use package + "/build" as base path.
            if (Platform.OS === 'ios' && NativeCodePush.getCurrentPackageBundlePath) {
                try {
                    const bundlePath = await NativeCodePush.getCurrentPackageBundlePath();
                    if (bundlePath && bundlePath.indexOf('/build/') !== -1) {
                        basePath = basePath.replace(/\/$/, '') + '/build';
                    }
                } catch (e) {
                    //
                }
            }
            codePushBasePath = basePath;
            patchAssetResolver();
        }
    } catch (error) {
        //
    }
}

// Register global function immediately
registerGlobalGetBaseURL();

// ============================================
// END CODEPUSH ASSET RESOLVER (iOS + Android)
// ============================================

async function checkForUpdate(deploymentKey = null, handleBinaryVersionMismatchCallback = null) {
    /*
     * Before we ask the server if an update exists, we
     * need to retrieve three pieces of information from the
     * native side: deployment key, app version (e.g. 1.0.1)
     * and the hash of the currently running update (if there is one).
     * This allows the client to only receive updates which are targetted
     * for their specific deployment and version and which are actually
     * different from the CodePush update they have already installed.
     */
    const nativeConfig = await getConfiguration();
    /*
     * If a deployment key was explicitly provided,
     * then let's override the one we retrieved
     * from the native-side of the app. This allows
     * dynamically "redirecting" end-users at different
     * deployments (e.g. an early access deployment for insiders).
     */
    const config = deploymentKey ? { ...nativeConfig, ...{ deploymentKey } } : nativeConfig;
    const sdk = getPromisifiedSdk(requestFetchAdapter, config);

    // Use dynamically overridden getCurrentPackage() during tests.
    const localPackage = await module.exports.getCurrentPackage();

    /*
     * If the app has a previously installed update, and that update
     * was targetted at the same app version that is currently running,
     * then we want to use its package hash to determine whether a new
     * release has been made on the server. Otherwise, we only need
     * to send the app version to the server, since we are interested
     * in any updates for current binary version, regardless of hash.
     */
    let queryPackage;
    if (localPackage) {
        queryPackage = localPackage;
    } else {
        queryPackage = { appVersion: config.appVersion };
        if (Platform.OS === 'ios' && config.packageHash) {
            queryPackage.packageHash = config.packageHash;
        }
    }

    const update = await sdk.queryUpdateWithCurrentPackage(queryPackage);

    /*
     * There are four cases where checkForUpdate will resolve to null:
     * ----------------------------------------------------------------
     * 1) The server said there isn't an update. This is the most common case.
     * 2) The server said there is an update but it requires a newer binary version.
     *    This would occur when end-users are running an older binary version than
     *    is available, and CodePush is making sure they don't get an update that
     *    potentially wouldn't be compatible with what they are running.
     * 3) The server said there is an update, but the update's hash is the same as
     *    the currently running update. This should _never_ happen, unless there is a
     *    bug in the server, but we're adding this check just to double-check that the
     *    client app is resilient to a potential issue with the update check.
     * 4) The server said there is an update, but the update's hash is the same as that
     *    of the binary's currently running version. This should only happen in Android -
     *    unlike iOS, we don't attach the binary's hash to the updateCheck request
     *    because we want to avoid having to install diff updates against the binary's
     *    version, which we can't do yet on Android.
     */
    if (
        !update ||
        update.updateAppVersion ||
        (localPackage && update.packageHash === localPackage.packageHash) ||
        ((!localPackage || localPackage._isDebugOnly) && config.packageHash === update.packageHash)
    ) {
        if (update && update.updateAppVersion) {
            log('An update is available but it is not targeting the binary version of your app.');
            if (handleBinaryVersionMismatchCallback && typeof handleBinaryVersionMismatchCallback === 'function') {
                handleBinaryVersionMismatchCallback(update);
            }
        }

        return null;
    } else {
        const remotePackage = { ...update, ...PackageMixins.remote(sdk.reportStatusDownload) };
        remotePackage.failedInstall = await NativeCodePush.isFailedUpdate(remotePackage.packageHash);
        remotePackage.deploymentKey = deploymentKey || nativeConfig.deploymentKey;
        return remotePackage;
    }
}

const getConfiguration = (() => {
    let config;
    return async function getConfiguration() {
        if (config) {
            return config;
        } else if (testConfig) {
            return testConfig;
        } else {
            config = await NativeCodePush.getConfiguration();
            return config;
        }
    };
})();

async function getCurrentPackage() {
    return await getUpdateMetadata(CodePush.UpdateState.LATEST);
}

async function getUpdateMetadata(updateState) {
    let updateMetadata = await NativeCodePush.getUpdateMetadata(updateState || CodePush.UpdateState.RUNNING);
    if (updateMetadata) {
        updateMetadata = { ...PackageMixins.local, ...updateMetadata };
        updateMetadata.failedInstall = await NativeCodePush.isFailedUpdate(updateMetadata.packageHash);
        updateMetadata.isFirstRun = await NativeCodePush.isFirstRun(updateMetadata.packageHash);
    }
    return updateMetadata;
}

function getPromisifiedSdk(requestFetchAdapter, config) {
    // Use dynamically overridden AcquisitionSdk during tests.
    const sdk = new module.exports.AcquisitionSdk(requestFetchAdapter, config);
    sdk.queryUpdateWithCurrentPackage = (queryPackage) => {
        return new Promise((resolve, reject) => {
            module.exports.AcquisitionSdk.prototype.queryUpdateWithCurrentPackage.call(sdk, queryPackage, (err, update) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(update);
                }
            });
        });
    };

    sdk.reportStatusDeploy = (deployedPackage, status, previousLabelOrAppVersion, previousDeploymentKey) => {
        return new Promise((resolve, reject) => {
            module.exports.AcquisitionSdk.prototype.reportStatusDeploy.call(
                sdk,
                deployedPackage,
                status,
                previousLabelOrAppVersion,
                previousDeploymentKey,
                (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                }
            );
        });
    };

    sdk.reportStatusDownload = (downloadedPackage) => {
        return new Promise((resolve, reject) => {
            module.exports.AcquisitionSdk.prototype.reportStatusDownload.call(sdk, downloadedPackage, (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    };

    return sdk;
}

// This ensures that notifyApplicationReadyInternal is only called once
// in the lifetime of this module instance.
const notifyApplicationReady = (() => {
    let notifyApplicationReadyPromise;
    return () => {
        if (!notifyApplicationReadyPromise) {
            notifyApplicationReadyPromise = notifyApplicationReadyInternal();
        }

        return notifyApplicationReadyPromise;
    };
})();

async function notifyApplicationReadyInternal() {
    await NativeCodePush.notifyApplicationReady();
    const statusReport = await NativeCodePush.getNewStatusReport();
    statusReport && tryReportStatus(statusReport); // Don't wait for this to complete.

    return statusReport;
}

async function tryReportStatus(statusReport, retryOnAppResume) {
    const config = await getConfiguration();
    const previousLabelOrAppVersion = statusReport.previousLabelOrAppVersion;
    const previousDeploymentKey = statusReport.previousDeploymentKey || config.deploymentKey;
    try {
        if (statusReport.appVersion) {
            log(`Reporting binary update (${statusReport.appVersion})`);

            if (!config.deploymentKey) {
                throw new Error('Deployment key is missed');
            }

            const sdk = getPromisifiedSdk(requestFetchAdapter, config);
            await sdk.reportStatusDeploy(/* deployedPackage */ null, /* status */ null, previousLabelOrAppVersion, previousDeploymentKey);
        } else {
            const label = statusReport.package.label;
            if (statusReport.status === 'DeploymentSucceeded') {
                log(`Reporting CodePush update success (${label})`);
            } else {
                log(`Reporting CodePush update rollback (${label})`);
                await NativeCodePush.setLatestRollbackInfo(statusReport.package.packageHash);
            }

            config.deploymentKey = statusReport.package.deploymentKey;
            const sdk = getPromisifiedSdk(requestFetchAdapter, config);
            await sdk.reportStatusDeploy(statusReport.package, statusReport.status, previousLabelOrAppVersion, previousDeploymentKey);
        }

        NativeCodePush.recordStatusReported(statusReport);
        retryOnAppResume && retryOnAppResume.remove();
    } catch (e) {
        log(`Report status failed: ${JSON.stringify(statusReport)}`);
        NativeCodePush.saveStatusReportForRetry(statusReport);
        // Try again when the app resumes
        if (!retryOnAppResume) {
            const resumeListener = AppState.addEventListener('change', async (newState) => {
                if (newState !== 'active') return;
                const refreshedStatusReport = await NativeCodePush.getNewStatusReport();
                if (refreshedStatusReport) {
                    tryReportStatus(refreshedStatusReport, resumeListener);
                } else {
                    resumeListener && resumeListener.remove();
                }
            });
        }
    }
}

async function shouldUpdateBeIgnored(remotePackage, syncOptions) {
    let { rollbackRetryOptions } = syncOptions;

    const isFailedPackage = remotePackage && remotePackage.failedInstall;
    if (!isFailedPackage || !syncOptions.ignoreFailedUpdates) {
        return false;
    }

    if (!rollbackRetryOptions) {
        return true;
    }

    if (typeof rollbackRetryOptions !== 'object') {
        rollbackRetryOptions = CodePush.DEFAULT_ROLLBACK_RETRY_OPTIONS;
    } else {
        rollbackRetryOptions = { ...CodePush.DEFAULT_ROLLBACK_RETRY_OPTIONS, ...rollbackRetryOptions };
    }

    if (!validateRollbackRetryOptions(rollbackRetryOptions)) {
        return true;
    }

    const latestRollbackInfo = await NativeCodePush.getLatestRollbackInfo();
    if (!validateLatestRollbackInfo(latestRollbackInfo, remotePackage.packageHash)) {
        log('The latest rollback info is not valid.');
        return true;
    }

    const { delayInHours, maxRetryAttempts } = rollbackRetryOptions;
    const hoursSinceLatestRollback = (Date.now() - latestRollbackInfo.time) / (1000 * 60 * 60);
    if (hoursSinceLatestRollback >= delayInHours && maxRetryAttempts >= latestRollbackInfo.count) {
        log('Previous rollback should be ignored due to rollback retry options.');
        return false;
    }

    return true;
}

function validateLatestRollbackInfo(latestRollbackInfo, packageHash) {
    return (
        latestRollbackInfo &&
        latestRollbackInfo.time &&
        latestRollbackInfo.count &&
        latestRollbackInfo.packageHash &&
        latestRollbackInfo.packageHash === packageHash
    );
}

function validateRollbackRetryOptions(rollbackRetryOptions) {
    if (typeof rollbackRetryOptions.delayInHours !== 'number') {
        log("The 'delayInHours' rollback retry parameter must be a number.");
        return false;
    }

    if (typeof rollbackRetryOptions.maxRetryAttempts !== 'number') {
        log("The 'maxRetryAttempts' rollback retry parameter must be a number.");
        return false;
    }

    if (rollbackRetryOptions.maxRetryAttempts < 1) {
        log("The 'maxRetryAttempts' rollback retry parameter cannot be less then 1.");
        return false;
    }

    return true;
}

let testConfig;

// This function is only used for tests. Replaces the default SDK, configuration and native bridge
function setUpTestDependencies(testSdk, providedTestConfig, testNativeBridge) {
    if (testSdk) module.exports.AcquisitionSdk = testSdk;
    if (providedTestConfig) testConfig = providedTestConfig;
    if (testNativeBridge) NativeCodePush = testNativeBridge;
}

async function restartApp(onlyIfUpdateIsPending = false) {
    NativeCodePush.restartApp(onlyIfUpdateIsPending);
}

// This function allows only one syncInternal operation to proceed at any given time.
// Parallel calls to sync() while one is ongoing yields CodePush.SyncStatus.SYNC_IN_PROGRESS.
const sync = (() => {
    let syncInProgress = false;
    const setSyncCompleted = () => {
        syncInProgress = false;
    };

    return (options = {}, syncStatusChangeCallback, downloadProgressCallback, handleBinaryVersionMismatchCallback) => {
        let syncStatusCallbackWithTryCatch, downloadProgressCallbackWithTryCatch;
        if (typeof syncStatusChangeCallback === 'function') {
            syncStatusCallbackWithTryCatch = (...args) => {
                try {
                    syncStatusChangeCallback(...args);
                } catch (error) {
                    log(`An error has occurred : ${error.stack}`);
                }
            };
        }

        if (typeof downloadProgressCallback === 'function') {
            downloadProgressCallbackWithTryCatch = (...args) => {
                try {
                    downloadProgressCallback(...args);
                } catch (error) {
                    log(`An error has occurred: ${error.stack}`);
                }
            };
        }

        if (syncInProgress) {
            typeof syncStatusCallbackWithTryCatch === 'function'
                ? syncStatusCallbackWithTryCatch(CodePush.SyncStatus.SYNC_IN_PROGRESS)
                : log('Sync already in progress.');
            return Promise.resolve(CodePush.SyncStatus.SYNC_IN_PROGRESS);
        }

        syncInProgress = true;
        const syncPromise = syncInternal(
            options,
            syncStatusCallbackWithTryCatch,
            downloadProgressCallbackWithTryCatch,
            handleBinaryVersionMismatchCallback
        );
        syncPromise.then(setSyncCompleted).catch(setSyncCompleted);

        return syncPromise;
    };
})();

/*
 * The syncInternal method provides a simple, one-line experience for
 * incorporating the check, download and installation of an update.
 *
 * It simply composes the existing API methods together and adds additional
 * support for respecting mandatory updates, ignoring previously failed
 * releases, and displaying a standard confirmation UI to the end-user
 * when an update is available.
 */
async function syncInternal(options = {}, syncStatusChangeCallback, downloadProgressCallback, handleBinaryVersionMismatchCallback) {
    let resolvedInstallMode;
    const syncOptions = {
        deploymentKey: null,
        ignoreFailedUpdates: true,
        rollbackRetryOptions: null,
        installMode: CodePush.InstallMode.ON_NEXT_RESTART,
        mandatoryInstallMode: CodePush.InstallMode.IMMEDIATE,
        minimumBackgroundDuration: 0,
        updateDialog: null,
        ...options
    };

    syncStatusChangeCallback =
        typeof syncStatusChangeCallback === 'function'
            ? syncStatusChangeCallback
            : (syncStatus) => {
                  switch (syncStatus) {
                      case CodePush.SyncStatus.CHECKING_FOR_UPDATE:
                          log('Checking for update.');
                          break;
                      case CodePush.SyncStatus.AWAITING_USER_ACTION:
                          log('Awaiting user action.');
                          break;
                      case CodePush.SyncStatus.DOWNLOADING_PACKAGE:
                          log('Downloading package.');
                          break;
                      case CodePush.SyncStatus.INSTALLING_UPDATE:
                          log('Installing update.');
                          break;
                      case CodePush.SyncStatus.UP_TO_DATE:
                          log('App is up to date.');
                          break;
                      case CodePush.SyncStatus.UPDATE_IGNORED:
                          log('User cancelled the update.');
                          break;
                      case CodePush.SyncStatus.UPDATE_INSTALLED:
                          if (resolvedInstallMode == CodePush.InstallMode.ON_NEXT_RESTART) {
                              log('Update is installed and will be run on the next app restart.');
                          } else if (resolvedInstallMode == CodePush.InstallMode.ON_NEXT_RESUME) {
                              if (syncOptions.minimumBackgroundDuration > 0) {
                                  log(
                                      `Update is installed and will be run after the app has been in the background for at least ${syncOptions.minimumBackgroundDuration} seconds.`
                                  );
                              } else {
                                  log('Update is installed and will be run when the app next resumes.');
                              }
                          }
                          break;
                      case CodePush.SyncStatus.UNKNOWN_ERROR:
                          log('An unknown error occurred.');
                          break;
                  }
              };

    try {
        await CodePush.notifyApplicationReady();

        syncStatusChangeCallback(CodePush.SyncStatus.CHECKING_FOR_UPDATE);
        const remotePackage = await checkForUpdate(syncOptions.deploymentKey, handleBinaryVersionMismatchCallback);

        const doDownloadAndInstall = async () => {
            syncStatusChangeCallback(CodePush.SyncStatus.DOWNLOADING_PACKAGE);
            const localPackage = await remotePackage.download(downloadProgressCallback);

            // Determine the correct install mode based on whether the update is mandatory or not.
            resolvedInstallMode = localPackage.isMandatory ? syncOptions.mandatoryInstallMode : syncOptions.installMode;

            syncStatusChangeCallback(CodePush.SyncStatus.INSTALLING_UPDATE);
            await localPackage.install(resolvedInstallMode, syncOptions.minimumBackgroundDuration, () => {
                syncStatusChangeCallback(CodePush.SyncStatus.UPDATE_INSTALLED);
            });

            return CodePush.SyncStatus.UPDATE_INSTALLED;
        };

        const updateShouldBeIgnored = await shouldUpdateBeIgnored(remotePackage, syncOptions);

        if (!remotePackage || updateShouldBeIgnored) {
            if (updateShouldBeIgnored) {
                log('An update is available, but it is being ignored due to having been previously rolled back.');
            }

            const currentPackage = await CodePush.getCurrentPackage();
            if (currentPackage && currentPackage.isPending) {
                syncStatusChangeCallback(CodePush.SyncStatus.UPDATE_INSTALLED);
                return CodePush.SyncStatus.UPDATE_INSTALLED;
            } else {
                syncStatusChangeCallback(CodePush.SyncStatus.UP_TO_DATE);
                return CodePush.SyncStatus.UP_TO_DATE;
            }
        } else if (syncOptions.updateDialog) {
            // updateDialog supports any truthy value (e.g. true, "goo", 12),
            // but we should treat a non-object value as just the default dialog
            if (typeof syncOptions.updateDialog !== 'object') {
                syncOptions.updateDialog = CodePush.DEFAULT_UPDATE_DIALOG;
            } else {
                syncOptions.updateDialog = { ...CodePush.DEFAULT_UPDATE_DIALOG, ...syncOptions.updateDialog };
            }

            return await new Promise((resolve, reject) => {
                let message = null;
                let installButtonText = null;

                const dialogButtons = [];

                if (remotePackage.isMandatory) {
                    message = syncOptions.updateDialog.mandatoryUpdateMessage;
                    installButtonText = syncOptions.updateDialog.mandatoryContinueButtonLabel;
                } else {
                    message = syncOptions.updateDialog.optionalUpdateMessage;
                    installButtonText = syncOptions.updateDialog.optionalInstallButtonLabel;
                    // Since this is an optional update, add a button
                    // to allow the end-user to ignore it
                    dialogButtons.push({
                        text: syncOptions.updateDialog.optionalIgnoreButtonLabel,
                        onPress: () => {
                            syncStatusChangeCallback(CodePush.SyncStatus.UPDATE_IGNORED);
                            resolve(CodePush.SyncStatus.UPDATE_IGNORED);
                        }
                    });
                }

                // Since the install button should be placed to the
                // right of any other button, add it last
                dialogButtons.push({
                    text: installButtonText,
                    onPress: () => {
                        doDownloadAndInstall().then(resolve, reject);
                    }
                });

                // If the update has a description, and the developer
                // explicitly chose to display it, then set that as the message
                if (syncOptions.updateDialog.appendReleaseDescription && remotePackage.description) {
                    message += `${syncOptions.updateDialog.descriptionPrefix} ${remotePackage.description}`;
                }

                syncStatusChangeCallback(CodePush.SyncStatus.AWAITING_USER_ACTION);
                Alert.alert(syncOptions.updateDialog.title, message, dialogButtons);
            });
        } else {
            return await doDownloadAndInstall();
        }
    } catch (error) {
        syncStatusChangeCallback(CodePush.SyncStatus.UNKNOWN_ERROR);
        log(error.message);
        throw error;
    }
}

let CodePush;

function codePushify(options = {}) {
    let React;
    let ReactNative = require('react-native');

    try {
        React = require('react');
    } catch (e) {}
    if (!React) {
        try {
            React = ReactNative.React;
        } catch (e) {}
        if (!React) {
            throw new Error("Unable to find the 'React' module.");
        }
    }

    if (!React.Component) {
        throw new Error(
            `Unable to find the "Component" class, please either:
1. Upgrade to a newer version of React Native that supports it, or
2. Call the codePush.sync API in your component instead of using the @codePush decorator`
        );
    }

    const decorator = (RootComponent) => {
        class CodePushComponent extends React.Component {
            constructor(props) {
                super(props);
                this.rootComponentRef = React.createRef();
            }

            componentDidMount() {
                if (options.checkFrequency === CodePush.CheckFrequency.MANUAL) {
                    CodePush.notifyAppReady();
                } else {
                    const rootComponentInstance = this.rootComponentRef.current;

                    let syncStatusCallback;
                    if (rootComponentInstance && rootComponentInstance.codePushStatusDidChange) {
                        syncStatusCallback = rootComponentInstance.codePushStatusDidChange.bind(rootComponentInstance);
                    }

                    let downloadProgressCallback;
                    if (rootComponentInstance && rootComponentInstance.codePushDownloadDidProgress) {
                        downloadProgressCallback = rootComponentInstance.codePushDownloadDidProgress.bind(rootComponentInstance);
                    }

                    let handleBinaryVersionMismatchCallback;
                    if (rootComponentInstance && rootComponentInstance.codePushOnBinaryVersionMismatch) {
                        handleBinaryVersionMismatchCallback =
                            rootComponentInstance.codePushOnBinaryVersionMismatch.bind(rootComponentInstance);
                    }

                    CodePush.sync(options, syncStatusCallback, downloadProgressCallback, handleBinaryVersionMismatchCallback);

                    if (options.checkFrequency === CodePush.CheckFrequency.ON_APP_RESUME) {
                        ReactNative.AppState.addEventListener('change', (newState) => {
                            if (newState === 'active') {
                                CodePush.sync(options, syncStatusCallback, downloadProgressCallback);
                            }
                        });
                    }
                }
            }

            render() {
                const props = { ...this.props };

                // We can set ref property on class components only (not stateless)
                // Check it by render method
                if (RootComponent.prototype && RootComponent.prototype.render) {
                    props.ref = this.rootComponentRef;
                }

                return <RootComponent {...props} />;
            }
        }

        return hoistStatics(CodePushComponent, RootComponent);
    };

    if (typeof options === 'function') {
        // Infer that the root component was directly passed to us.
        return decorator(options);
    } else {
        return decorator;
    }
}

// If the "NativeCodePush" variable isn't defined, then
// the app didn't properly install the native module,
// and therefore, it doesn't make sense initializing
// the JS interface when it wouldn't work anyways.
if (NativeCodePush) {
    // Initialize base path (iOS + Android) and asset resolver (Android only)
    initializeAssetResolver();

    CodePush = codePushify;
    Object.assign(CodePush, {
        AcquisitionSdk: Sdk,
        checkForUpdate,
        getConfiguration,
        getCurrentPackage,
        getUpdateMetadata,
        getBaseURL,
        log,
        notifyAppReady: notifyApplicationReady,
        notifyApplicationReady,
        restartApp,
        setUpTestDependencies,
        sync,
        disallowRestart: NativeCodePush.disallow,
        allowRestart: NativeCodePush.allow,
        clearUpdates: NativeCodePush.clearUpdates,
        InstallMode: {
            IMMEDIATE: NativeCodePush.codePushInstallModeImmediate, // Restart the app immediately
            ON_NEXT_RESTART: NativeCodePush.codePushInstallModeOnNextRestart, // Don't artificially restart the app. Allow the update to be "picked up" on the next app restart
            ON_NEXT_RESUME: NativeCodePush.codePushInstallModeOnNextResume, // Restart the app the next time it is resumed from the background
            ON_NEXT_SUSPEND: NativeCodePush.codePushInstallModeOnNextSuspend // Restart the app _while_ it is in the background,
            // but only after it has been in the background for "minimumBackgroundDuration" seconds (0 by default),
            // so that user context isn't lost unless the app suspension is long enough to not matter
        },
        SyncStatus: {
            UP_TO_DATE: 0, // The running app is up-to-date
            UPDATE_INSTALLED: 1, // The app had an optional/mandatory update that was successfully downloaded and is about to be installed.
            UPDATE_IGNORED: 2, // The app had an optional update and the end-user chose to ignore it
            UNKNOWN_ERROR: 3,
            SYNC_IN_PROGRESS: 4, // There is an ongoing "sync" operation in progress.
            CHECKING_FOR_UPDATE: 5,
            AWAITING_USER_ACTION: 6,
            DOWNLOADING_PACKAGE: 7,
            INSTALLING_UPDATE: 8
        },
        CheckFrequency: {
            ON_APP_START: 0,
            ON_APP_RESUME: 1,
            MANUAL: 2
        },
        UpdateState: {
            RUNNING: NativeCodePush.codePushUpdateStateRunning,
            PENDING: NativeCodePush.codePushUpdateStatePending,
            LATEST: NativeCodePush.codePushUpdateStateLatest
        },
        DeploymentStatus: {
            FAILED: 'DeploymentFailed',
            SUCCEEDED: 'DeploymentSucceeded'
        },
        DEFAULT_UPDATE_DIALOG: {
            appendReleaseDescription: false,
            descriptionPrefix: ' Description: ',
            mandatoryContinueButtonLabel: 'Continue',
            mandatoryUpdateMessage: 'An update is available that must be installed.',
            optionalIgnoreButtonLabel: 'Ignore',
            optionalInstallButtonLabel: 'Install',
            optionalUpdateMessage: 'An update is available. Would you like to install it?',
            title: 'Update available'
        },
        DEFAULT_ROLLBACK_RETRY_OPTIONS: {
            delayInHours: 24,
            maxRetryAttempts: 1
        }
    });
} else {
    log("The CodePush module doesn't appear to be properly installed. Please double-check that everything is setup correctly.");
}

module.exports = CodePush;
